import { Plugin } from "@opencode/plugin";
import type { Credential } from "@opencode/plugin";
import {
  applyGatewayCatalogSnapshot,
  type CatalogProviderIDs,
} from "./catalog.js";
import { createAdminAuthHook } from "./auth-hook.js";
import { defaultConfigModel, type ConfigModel } from "./model-config.js";
import {
  addSharedModelDefaults,
  mergeRoutedModels,
  routeModelRequest,
  prepareGatewayRequest,
} from "./model-routing.js";
import {
  discoverFromDevMate,
  discoverFromWorkspaceProfile,
  type ModelDiscoveryOptions,
} from "./model-discovery.js";
import { stripRateLimitRetryAfter } from "./request.js";
import { loadConfig } from "./config/loader.js";
import {
  devmateBaseURL as configuredDevMateBaseURL,
  devmateNativeBaseURL as configuredDevMateNativeBaseURL,
  discoveryFromConfig,
  gatewayBaseURL as configuredGatewayBaseURL,
  gatewayNativeBaseURL as configuredGatewayNativeBaseURL,
  routingFromConfig,
  staticModelOverlays,
} from "./config/mapping.js";
import { mergeRecordOverlay } from "./model-merge.js";
import { emptyRuntimeSnapshot, type RuntimeSnapshot } from "./runtime.js";
import { findNativeAdapterByPackage } from "./native-adapters.js";
import { DEFAULT_PROVIDER_IDS, type ResolvedConfig } from "./config/types.js";
import { registerAutoContinue } from "./auto-continue.js";

type ModelRecord = Record<string, Record<string, unknown>>;

export type ConfigState =
  | { kind: "ready"; path: string; value: ResolvedConfig }
  | { kind: "empty"; path?: string; error?: Error };

type DiagnosticCounts = { warnings: number; errors: number };

type RefreshSummary = {
  status: "published" | "preserved";
  reason: "config" | "discovery" | "catalog" | "runtime";
  path?: string;
  models: number;
};

type DiscoverySourceResult =
  | { source: "workspace" | "devmate"; models: ModelRecord }
  | { source: "workspace" | "devmate"; error: Error };

/** npm package name of this gateway provider (used as the catalog `package`). */
export const GATEWAY_PACKAGE = "opencode-zmllmgw";

/** Resolve the effective provider integration IDs from configuration (defaults when absent). */
function providerIDsFor(
  config: ResolvedConfig | undefined,
): CatalogProviderIDs & { admin: string } {
  return {
    gateway: config?.providers.gateway.id ?? DEFAULT_PROVIDER_IDS.gateway,
    gatewayPackage: GATEWAY_PACKAGE,
    devmate: config?.providers.devmate?.id ?? DEFAULT_PROVIDER_IDS.devmate,
    admin: config?.providers.admin?.id ?? DEFAULT_PROVIDER_IDS.admin,
  };
}

function adminEndpoint(config: ResolvedConfig | undefined): string | undefined {
  const endpoint = config?.providers.admin?.endpoint;
  return endpoint ? endpoint.replace(/\/+$/, "") : undefined;
}

function createDiscoveryLogger(counts: DiagnosticCounts) {
  return async (entry: {
    service: string;
    level: "warn" | "error";
    message: string;
  }): Promise<void> => {
    if (entry.level === "error") counts.errors += 1;
    else counts.warnings += 1;
    const message = `[${entry.service}] ${entry.message}`;
    if (entry.level === "error") console.error(message);
    else console.warn(message);
  };
}

function credentialKey(
  value: Credential.Value | undefined,
): string | undefined {
  return value?.type === "key" && value.key ? value.key : undefined;
}

function credentialAccess(
  value: Credential.Value | undefined,
): string | undefined {
  return value?.type === "oauth" && value.access ? value.access : undefined;
}

async function resolveCredential(
  ctx: Plugin.Context,
  integrationID: string,
): Promise<Credential.Value | undefined> {
  const connection = await ctx.integration.connection.active(integrationID);
  return connection
    ? ctx.integration.connection.resolve(connection)
    : undefined;
}

function configPathFromError(error: unknown): string | undefined {
  return error instanceof Error &&
    "filePath" in error &&
    typeof error.filePath === "string"
    ? error.filePath
    : undefined;
}

async function readConfigState(
  logger: ReturnType<typeof createDiscoveryLogger>,
): Promise<ConfigState> {
  try {
    const loaded = await loadConfig();
    if (loaded.config)
      return { kind: "ready", path: loaded.path!, value: loaded.config };

    const message = loaded.path
      ? `configuration file not found: ${loaded.path}; using an empty runtime`
      : "configuration file not found; using an empty runtime";
    await logger({ service: "zmllmgw", level: "warn", message });
    return { kind: "empty", path: loaded.path };
  } catch (error) {
    const parsed = error instanceof Error ? error : new Error(String(error));
    await logger({
      service: "zmllmgw",
      level: "error",
      message: `configuration load failed; using an empty runtime: ${parsed.message}`,
    });
    return { kind: "empty", path: configPathFromError(error), error: parsed };
  }
}

function mergeGatewayModels(
  discovered: ModelRecord,
  config: ResolvedConfig,
): ModelRecord {
  const models: ModelRecord = { ...discovered };
  const overlays = staticModelOverlays(config);
  for (const configured of config.models) {
    const base =
      models[configured.gatewayId] ??
      (defaultConfigModel(configured.gatewayId) as unknown as Record<
        string,
        unknown
      >);
    models[configured.gatewayId] = mergeRecordOverlay(
      base,
      overlays[configured.gatewayId] ?? {},
    );
  }
  return models;
}

function inheritGatewayPackages(
  gatewayModels: ModelRecord,
  devmateModels: ModelRecord,
  config: ResolvedConfig,
): ModelRecord {
  const models: ModelRecord = { ...devmateModels };
  for (const [modelID, model] of Object.entries(models)) {
    const configured = config.models.find((item) => item.devmateId === modelID);
    const gatewayModel = configured
      ? gatewayModels[configured.gatewayId]
      : gatewayModels[modelID];
    if (!gatewayModel) continue;
    models[modelID] = mergeRecordOverlay(model, {
      package: gatewayModel.package,
    });
  }
  return models;
}

function snapshotForConfig(
  config: ResolvedConfig,
  discoveredGateway: ModelRecord = {},
  discoveredDevMate: ModelRecord = {},
): RuntimeSnapshot {
  let gatewayModels = mergeGatewayModels(discoveredGateway, config);
  const devmateModels = inheritGatewayPackages(
    gatewayModels,
    discoveredDevMate,
    config,
  );
  let routing = routingFromConfig(config);

  if (routing) {
    routing = addSharedModelDefaults(
      { models: gatewayModels },
      { models: devmateModels },
      routing,
    );
    gatewayModels = mergeRoutedModels(
      { models: gatewayModels },
      { models: devmateModels },
      routing,
    );
  }

  return {
    gateway: {
      baseURL: configuredGatewayBaseURL(config),
      nativeBaseURL: configuredGatewayNativeBaseURL(config),
      models: gatewayModels as Record<string, ConfigModel>,
    },
    devmate: {
      baseURL: configuredDevMateBaseURL(config),
      nativeBaseURL: configuredDevMateNativeBaseURL(config),
      models: devmateModels as Record<string, ConfigModel>,
    },
    ...(routing ? { routing } : {}),
  };
}

function modelCount(snapshot: RuntimeSnapshot): number {
  return Object.keys(snapshot.gateway.models).length;
}

export const Zmllmgw = Plugin.define({
  id: "opencode-zmllmgw",
  async setup(ctx) {
    const diagnostics: DiagnosticCounts = { warnings: 0, errors: 0 };
    const logger = createDiscoveryLogger(diagnostics);

    let adminBaseURL: string | undefined;
    let providerIDs = providerIDsFor(undefined);
    let activeSnapshot = emptyRuntimeSnapshot();
    let activeConfig: ResolvedConfig | undefined;
    let projectionSnapshot = activeSnapshot;
    let hasPublishedSnapshot = false;
    let inFlightRefresh: Promise<RefreshSummary> | undefined;

    // Resolve provider IDs and the admin endpoint before the first transform so
    // the provider boundary and integrations are bound to the configured IDs
    // (or the defaults) from the very first setup pass.
    const initialConfigState = await readConfigState(logger);
    if (initialConfigState.kind === "ready") {
      providerIDs = providerIDsFor(initialConfigState.value);
      adminBaseURL = adminEndpoint(initialConfigState.value);
    }

    await ctx.catalog.transform((catalog) => {
      applyGatewayCatalogSnapshot(
        catalog,
        {
          baseURL: projectionSnapshot.gateway.baseURL,
          models: projectionSnapshot.gateway.models,
        },
        providerIDs,
      );
    });

    await ctx.integration.transform((editor) => {
      // The admin OAuth integration only exists when an admin endpoint is
      // configured; the transform re-reads the closures so reloads pick up
      // endpoint/ID changes.
      if (adminBaseURL) {
        editor.update(providerIDs.admin, (integration) => {
          integration.name = "ZMLLMADM";
        });
        editor.method.update(
          createAdminAuthHook({
            adminBaseURL,
            adminProviderID: providerIDs.admin,
          }),
        );
      } else if (editor.get(providerIDs.admin)) {
        editor.remove(providerIDs.admin);
      }

      editor.update(providerIDs.devmate, (integration) => {
        integration.name = "ZMDEVMATE";
      });
      editor.method.update({
        integrationID: providerIDs.devmate,
        method: { type: "key", label: "ZMDEVMATE API key" },
      });

      editor.update(providerIDs.gateway, (integration) => {
        integration.name = "ZMLLMGW";
      });
      editor.method.update({
        integrationID: providerIDs.gateway,
        method: { type: "key", label: "ZMLLMGW API key" },
      });
    });

    async function syncAdminAuth(
      config: ResolvedConfig | undefined,
    ): Promise<boolean> {
      const nextBaseURL = adminEndpoint(config);
      if (nextBaseURL === adminBaseURL) return true;
      const previousBaseURL = adminBaseURL;
      adminBaseURL = nextBaseURL;
      try {
        await ctx.integration.reload();
        return true;
      } catch (error) {
        adminBaseURL = previousBaseURL;
        await logger({
          service: "zmllmgw",
          level: "error",
          message: `integration reload failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        return false;
      }
    }

    async function discover(
      config: ResolvedConfig,
      force: boolean,
    ): Promise<{
      gateway: ModelRecord;
      devmate: ModelRecord;
      failed: boolean;
    }> {
      const discovery: ModelDiscoveryOptions = discoveryFromConfig(config);
      const tasks: Array<Promise<DiscoverySourceResult>> = [];

      if (adminBaseURL) {
        tasks.push(
          (async () => {
            try {
              const credential = await resolveCredential(
                ctx,
                providerIDs.admin,
              );
              const accessToken = credentialAccess(credential);
              if (!accessToken) {
                throw new Error(
                  `no Okta credential; run /connect for ${providerIDs.admin}`,
                );
              }
              const result = await discoverFromWorkspaceProfile({
                discovery,
                adminBaseURL,
                accessToken,
                force,
              });
              return { source: "workspace", models: result.models };
            } catch (error) {
              return {
                source: "workspace",
                error:
                  error instanceof Error ? error : new Error(String(error)),
              };
            }
          })(),
        );
      }

      const devmateBaseURL = configuredDevMateBaseURL(config);
      if (devmateBaseURL) {
        tasks.push(
          (async () => {
            try {
              const credential = await resolveCredential(
                ctx,
                providerIDs.devmate,
              );
              const apiKey = credentialKey(credential);
              if (!apiKey) {
                throw new Error(
                  `no API key; run /connect for ${providerIDs.devmate}`,
                );
              }
              const models = await discoverFromDevMate({
                discovery,
                baseURL: devmateBaseURL,
                apiKey,
              });
              return { source: "devmate", models };
            } catch (error) {
              return {
                source: "devmate",
                error:
                  error instanceof Error ? error : new Error(String(error)),
              };
            }
          })(),
        );
      }

      const results = await Promise.all(tasks);
      const gateway: ModelRecord = {};
      const devmate: ModelRecord = {};
      let failed = false;
      for (const result of results) {
        if ("error" in result) {
          failed = true;
          await logger({
            service: result.source === "workspace" ? "zmllmgw" : "zmdevmate",
            level: "error",
            message: result.error.message,
          });
        } else if (result.source === "workspace") {
          Object.assign(gateway, result.models);
        } else {
          Object.assign(devmate, result.models);
        }
      }
      return { gateway, devmate, failed };
    }

    async function publish(
      snapshot: RuntimeSnapshot,
      reason: RefreshSummary["reason"],
      path?: string,
    ): Promise<RefreshSummary> {
      const previousProjection = projectionSnapshot;
      projectionSnapshot = snapshot;
      try {
        await ctx.catalog.reload();
        activeSnapshot = snapshot;
        hasPublishedSnapshot = true;
        return {
          status: "published",
          reason,
          path,
          models: modelCount(snapshot),
        };
      } catch (error) {
        projectionSnapshot = previousProjection;
        await logger({
          service: "zmllmgw",
          level: "error",
          message: `catalog reload failed; keeping the previous snapshot: ${error instanceof Error ? error.message : String(error)}`,
        });
        return {
          status: "preserved",
          reason: "catalog",
          path,
          models: modelCount(activeSnapshot),
        };
      }
    }

    async function performRefresh(force: boolean): Promise<RefreshSummary> {
      const configState = await readConfigState(logger);
      const config =
        configState.kind === "ready" ? configState.value : undefined;
      providerIDs = providerIDsFor(config);
      if (!config) {
        // A configuration-source failure has its own policy: explicitly publish
        // the empty runtime, even when a previous configuration was active.
        await syncAdminAuth(undefined);
        activeConfig = undefined;
        return publish(emptyRuntimeSnapshot(), "config", configState.path);
      }

      activeConfig = config;

      const staticSnapshot = snapshotForConfig(config);
      if (!(await syncAdminAuth(config))) {
        if (hasPublishedSnapshot)
          return {
            status: "preserved",
            reason: "runtime",
            path: configState.path,
            models: modelCount(activeSnapshot),
          };
        return publish(staticSnapshot, "runtime", configState.path);
      }

      const result = await discover(config, force);
      if (result.failed) {
        if (hasPublishedSnapshot)
          return {
            status: "preserved",
            reason: "discovery",
            path: configState.path,
            models: modelCount(activeSnapshot),
          };
        return publish(staticSnapshot, "discovery", configState.path);
      }

      const snapshot = snapshotForConfig(
        config,
        result.gateway,
        result.devmate,
      );
      return publish(snapshot, "config", configState.path);
    }

    const refresh = (force: boolean): Promise<RefreshSummary> => {
      if (inFlightRefresh) return inFlightRefresh;
      const flight = performRefresh(force)
        .catch(async (error): Promise<RefreshSummary> => {
          await logger({
            service: "zmllmgw",
            level: "error",
            message: `refresh failed; keeping the previous snapshot: ${error instanceof Error ? error.message : String(error)}`,
          });
          return {
            status: "preserved",
            reason: "runtime",
            models: modelCount(activeSnapshot),
          };
        })
        .finally(() => {
          if (inFlightRefresh === flight) inFlightRefresh = undefined;
        });
      inFlightRefresh = flight;
      return flight;
    };

    await ctx.command.transform((editor) => {
      editor.add({
        name: "reload-zmllmgw",
        description: "Reload ZMLLMGW configuration and discover models",
        execute: async () => {
          diagnostics.warnings = 0;
          diagnostics.errors = 0;
          const result = await refresh(true);
          console.info(
            `[zmllmgw] reload ${JSON.stringify({
              ...result,
              warnings: diagnostics.warnings,
              errors: diagnostics.errors,
            })}`,
          );
        },
      });
    });

    const disposeAutoContinue = await registerAutoContinue({
      ctx,
      providerID: () => providerIDs.gateway,
      config: () => activeConfig,
    });

    await ctx.session.hook("http.request", async (event) => {
      if (event.model.providerID !== providerIDs.gateway) return;
      const snapshot = activeSnapshot;
      const gateway = snapshot.gateway;
      if (!gateway.baseURL) return;

      const model = gateway.models[event.model.id];
      const adapter = findNativeAdapterByPackage(model?.package ?? "");
      const gatewayCredential = await resolveCredential(
        ctx,
        providerIDs.gateway,
      );
      const gatewayApiKey = credentialKey(gatewayCredential);

      if (snapshot.routing) {
        const routed = await routeModelRequest({
          request: event.request,
          modelID: event.model.id,
          routing: snapshot.routing,
          sourceBaseURL: gateway.baseURL,
          gatewayBaseURL: gateway.baseURL,
          gatewayNativeBaseURL: gateway.nativeBaseURL,
          devmateBaseURL: snapshot.devmate.baseURL,
          devmateNativeBaseURL: snapshot.devmate.nativeBaseURL,
          sessionID: event.sessionID,
          gatewayApiKey,
          gatewayIntegrationID: providerIDs.gateway,
          devmateIntegrationID: providerIDs.devmate,
          adapter,
          readApiKey: async () =>
            credentialKey(await resolveCredential(ctx, providerIDs.devmate)),
        });
        event.request = routed.request;
        return;
      }

      event.request = await prepareGatewayRequest({
        request: event.request,
        sourceBaseURL: gateway.baseURL,
        modelID: event.model.id,
        gatewayBaseURL: gateway.baseURL,
        gatewayNativeBaseURL: gateway.nativeBaseURL,
        sessionID: event.sessionID,
        gatewayApiKey,
        integrationID: providerIDs.gateway,
        adapter,
      });
    });

    await ctx.session.hook("http.response", async (event) => {
      if (
        event.model.providerID !== providerIDs.gateway ||
        event.response.status !== 429
      )
        return;
      const diagnostic = {
        url: event.request.url,
        status: event.response.status,
        headers: rateLimitHeaders(event.response),
        body: await event.response
          .clone()
          .text()
          .catch(() => ""),
      };
      console.error(
        `[zmllmgw] rate limit response: ${JSON.stringify(diagnostic)}`,
      );
      event.response = stripRateLimitRetryAfter(event.response);
    });

    await refresh(false);

    return () => {
      void disposeAutoContinue();
    };
  },
});

function rateLimitHeaders(response: Response): Record<string, string> {
  return Object.fromEntries(
    [...response.headers].filter(
      ([name]) =>
        name === "retry-after" ||
        name === "retry-after-ms" ||
        name === "request-id" ||
        name === "x-request-id" ||
        name.startsWith("x-ratelimit-"),
    ),
  );
}

export default Zmllmgw;
