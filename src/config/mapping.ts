import { packageForConfigApi } from "../native-adapters.js";
import { reasoningVariantsForAPI, type ConfigModel } from "../model-config.js";
import type { ModelRoutingOptions, ModelRoutingRule } from "../options.js";
import type { ModelDiscoveryOptions } from "../model-discovery.js";
import type {
  RawConfigModel,
  ResolvedConfig,
  ResolvedConfigModel,
} from "./types.js";

function appendPath(baseURL: string, path: string): string {
  const url = new URL(baseURL);
  const current = url.pathname.replace(/\/+$/, "");
  url.pathname = `${current}/${path.replace(/^\/+/, "")}`;
  return url.toString();
}

export function gatewayBaseURL(config: ResolvedConfig): string {
  return appendPath(config.providers.gateway.endpoint, "v1");
}

export function gatewayNativeBaseURL(config: ResolvedConfig): string {
  return gatewayBaseURL(config);
}

export function devmateBaseURL(config: ResolvedConfig): string | undefined {
  return config.providers.devmate?.endpoint
    ? appendPath(config.providers.devmate.endpoint, "v1")
    : undefined;
}

export function devmateNativeBaseURL(
  config: ResolvedConfig,
): string | undefined {
  return devmateBaseURL(config);
}

function variantSettings(
  model: RawConfigModel,
): ConfigModel["variants"] | undefined {
  const api = model.api ?? "openai-completions";
  if (model.variants) {
    return model.variants.flatMap((variant) =>
      variant.reasoningEffort
        ? reasoningVariantsForAPI(api, [variant.reasoningEffort])
        : [{ id: variant.id, settings: {} }],
    );
  }
  if (model.reasoning === true) return reasoningVariantsForAPI(api);
  if (model.reasoning === false) return [];
  return undefined;
}

/** Convert a static model into a partial catalog overlay. */
export function staticModelOverlay(
  model: RawConfigModel,
): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {};
  if (model.tools !== undefined) capabilities.tools = model.tools;
  if (model.vision !== undefined)
    capabilities.input = model.vision ? ["text", "image"] : ["text"];

  const overlay: Record<string, unknown> = {};
  if (model.name !== undefined) overlay.name = model.name;
  if (Object.keys(capabilities).length > 0) overlay.capabilities = capabilities;
  if (model.limit !== undefined) overlay.limit = model.limit;
  if (model.api !== undefined) overlay.package = packageForConfigApi(model.api);
  const variants = variantSettings(model);
  if (variants !== undefined) overlay.variants = variants;
  return overlay;
}

function endpoint(
  provider: "gateway" | "devmate",
  model: ResolvedConfigModel,
): { provider: "gateway" | "devmate"; model: string } {
  return {
    provider,
    model: provider === "devmate" ? model.devmateId : model.gatewayId,
  };
}

export function staticModelOverlays(
  config: ResolvedConfig,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    config.models.map((model) => [model.gatewayId, staticModelOverlay(model)]),
  );
}

export function routingFromConfig(
  config: ResolvedConfig,
): ModelRoutingOptions | undefined {
  const models: Record<string, ModelRoutingRule> = {};
  for (const model of config.models) {
    const schedule = model.schedule;
    if (!schedule) continue;
    models[model.gatewayId] = {
      windows: schedule.windows,
      ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
      ...(schedule.within ? { within: endpoint(schedule.within, model) } : {}),
      beyond: endpoint(schedule.beyond, model),
    };
  }
  if (Object.keys(models).length === 0 && !devmateBaseURL(config))
    return undefined;
  return {
    ...(devmateBaseURL(config)
      ? { devmateBaseURL: devmateBaseURL(config) }
      : {}),
    models,
  };
}

export function discoveryFromConfig(
  config: ResolvedConfig,
): ModelDiscoveryOptions {
  return {
    cacheTtl: config.cache.ttl,
    vendors: config.filters.vendors,
    include: config.filters.include,
    exclude: config.filters.exclude,
  };
}
