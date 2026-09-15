import {
  rewriteURLWithPathInsert,
  type NativeVendorAdapter,
} from "./native-adapters.js";
import { mergeRecordOverlay } from "./model-merge.js";
import {
  parseModelRoutingOptions,
  type ModelRoutingEndpoint,
  type ModelRoutingOptions,
  type ModelRoutingRule,
  type ModelRoutingTimeWindow,
} from "./options.js";

export type ProviderConfigLike = {
  models?: Record<string, Record<string, unknown>>;
};

type Clock = (now: Date) => { minutes: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function localClock(now: Date): { minutes: number } {
  return { minutes: now.getHours() * 60 + now.getMinutes() };
}

function zonedClock(timezone: string): Clock {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  return (now) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(now).map((part) => [part.type, part.value]),
    );
    return { minutes: Number(parts.hour) * 60 + Number(parts.minute) };
  };
}

export function createRoutingClock(timezone?: string): Clock {
  if (!timezone) return localClock;
  return zonedClock(timezone);
}

export function isWithinRoutingWindow(
  now: Date,
  window: ModelRoutingTimeWindow,
  clock: Clock = localClock,
): boolean {
  const current = clock(now).minutes;
  const start = clockMinutes(window.start);
  const end = clockMinutes(window.end);
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

export function targetForModel(
  modelId: string,
  routing: ModelRoutingOptions,
  now: Date,
  clock?: Clock,
): "gateway" | "devmate" {
  return routeForModel(modelId, routing, now, clock).provider;
}

export function routeForModel(
  modelId: string,
  routing: ModelRoutingOptions,
  now: Date,
  clock?: Clock,
): ModelRoutingEndpoint {
  const rule = routing.models[modelId];
  if (!rule)
    return (
      routing.defaultModels?.[modelId] ?? {
        provider: "gateway",
        model: modelId,
      }
    );
  const effectiveClock =
    clock ?? createRoutingClock(rule.timezone ?? routing.timezone);
  return rule.within &&
    rule.windows.some((window) =>
      isWithinRoutingWindow(now, window, effectiveClock),
    )
    ? rule.within
    : rule.beyond;
}

function requestURL(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  return new URL(input.url);
}

function pathWithoutTrailingSlash(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed || "/";
}

/** Replace only the service base path and preserve the request suffix/query. */
export function replaceRequestBaseURL(
  input: RequestInfo | URL,
  sourceBaseURL: string,
  targetBaseURL: string,
): string {
  const inputURL = requestURL(input);
  const sourceURL = new URL(sourceBaseURL);
  const sourcePath = pathWithoutTrailingSlash(sourceURL.pathname);
  const inputPath = inputURL.pathname;
  let suffix = inputPath;
  if (sourcePath === "/") {
    suffix = inputPath;
  } else if (inputPath === sourcePath) {
    suffix = "";
  } else if (inputPath.startsWith(`${sourcePath}/`)) {
    suffix = inputPath.slice(sourcePath.length);
  }

  const targetURL = new URL(targetBaseURL);
  const targetPath = pathWithoutTrailingSlash(targetURL.pathname);
  const suffixPath = suffix.replace(/^\/+/, "");
  targetURL.pathname =
    targetPath === "/"
      ? `/${suffixPath}`.replace(/\/$/, "") || "/"
      : `${targetPath}${suffixPath ? `/${suffixPath}` : ""}`;
  targetURL.search = inputURL.search;
  targetURL.hash = inputURL.hash;
  return targetURL.toString();
}

export type RequestTarget = {
  provider: "gateway" | "devmate";
  model: string;
  protocol: "native" | "compatible";
};

export type TargetRequestOptions = {
  request: Request;
  sourceBaseURL: string;
  catalogModelID?: string;
  target: RequestTarget;
  /** Integration ID of the target provider, used for key-missing guidance. */
  integrationID: string;
  gatewayBaseURL: string;
  gatewayNativeBaseURL?: string;
  devmateBaseURL?: string;
  devmateNativeBaseURL?: string;
  sessionID: string;
  gatewayApiKey?: string;
  devmateApiKey?: string;
  adapter?: NativeVendorAdapter;
  validateJSONBody?: boolean;
};

export type ModelRoutingRequestOptions = Omit<
  TargetRequestOptions,
  "target" | "devmateApiKey" | "validateJSONBody" | "integrationID"
> & {
  modelID: string;
  routing: ModelRoutingOptions;
  readApiKey: () => Promise<string | undefined>;
  now?: () => Date;
  /** Integration ID of the Gateway provider, for missing-key guidance. */
  gatewayIntegrationID: string;
  /** Integration ID of the DevMate provider, for missing-key guidance. */
  devmateIntegrationID: string;
};

export type ModelRoutingRequestResult = {
  request: Request;
  target: "gateway" | "devmate";
  requestTarget: RequestTarget;
};

/** Rebuild a request while preserving the standard Request init fields. */
export async function replaceRequest(
  input: Request,
  url: string,
  headers: Headers,
  body?: string,
): Promise<Request> {
  const init: RequestInit = {
    method: input.method,
    headers,
    cache: input.cache,
    credentials: input.credentials,
    integrity: input.integrity,
    keepalive: input.keepalive,
    mode: input.mode,
    redirect: input.redirect,
    referrer: input.referrer,
    referrerPolicy: input.referrerPolicy,
    signal: input.signal,
  };
  if (input.method !== "GET" && input.method !== "HEAD")
    init.body = body ?? (await input.clone().arrayBuffer());
  return new Request(url, init);
}

async function requestBody(
  request: Request,
  modelID: string | undefined,
  targetModel: string | undefined,
  sessionID: string,
  validate: boolean,
  replaceBodyModel: boolean,
): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const text = await request
    .clone()
    .text()
    .catch(() => "");
  if (!text) {
    if (validate) throw new Error("ZMLLMGW: routed request body is empty");
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (validate)
      throw new Error("ZMLLMGW: routed request body is not valid JSON");
    return undefined;
  }
  if (!isRecord(parsed)) {
    if (validate)
      throw new Error("ZMLLMGW: routed request body must be a JSON object");
    return undefined;
  }

  parsed.task_id = sessionID;
  if (replaceBodyModel && modelID && targetModel && targetModel !== modelID)
    parsed.model = targetModel;
  return JSON.stringify(parsed);
}

/** Prepare either Gateway or DevMate at the final HTTP boundary. */
export async function prepareRequestForTarget(
  options: TargetRequestOptions,
): Promise<Request> {
  const apiKey =
    options.target.provider === "gateway"
      ? options.gatewayApiKey
      : options.devmateApiKey;
  if (!apiKey) {
    throw new Error(
      `ZMLLMGW: missing ${options.integrationID} API key; run /connect for ${options.integrationID}`,
    );
  }

  const compatibleBaseURL =
    options.target.provider === "gateway"
      ? options.gatewayBaseURL
      : options.devmateBaseURL;
  if (!compatibleBaseURL)
    throw new Error(
      `ZMLLMGW: ${options.target.provider} endpoint is not configured`,
    );

  const nativeBaseURL =
    options.target.provider === "gateway"
      ? options.gatewayNativeBaseURL
      : options.devmateNativeBaseURL;
  const targetBaseURL =
    options.adapter?.rewriteURL && nativeBaseURL
      ? nativeBaseURL
      : compatibleBaseURL;
  let url = replaceRequestBaseURL(
    options.request,
    options.sourceBaseURL,
    targetBaseURL,
  );
  if (options.adapter?.rewriteURL && nativeBaseURL) {
    url = rewriteURLWithPathInsert(
      nativeBaseURL,
      options.adapter.rewriteURL,
      url,
    );
  }
  if (
    options.adapter?.replaceModelURL &&
    options.catalogModelID &&
    options.target.model !== options.catalogModelID
  ) {
    url = options.adapter.replaceModelURL(
      url,
      options.catalogModelID,
      options.target.model,
    );
  }
  const headers = new Headers(options.request.headers);
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  headers.delete("llm-settings");
  headers.set("user-agent", "");

  if (options.target.provider === "gateway") {
    headers.set("x-api-key", apiKey);
    if (options.adapter?.headers) {
      for (const [name, value] of Object.entries(
        options.adapter.headers({ apiKey }),
      ))
        headers.set(name, value);
    }
  } else {
    headers.set("authorization", `Bearer ${apiKey}`);
  }

  const body = await requestBody(
    options.request,
    options.catalogModelID,
    options.target.model,
    options.sessionID,
    options.validateJSONBody ?? false,
    options.target.protocol === "compatible" ||
      options.adapter?.modelInBody !== false,
  );
  return replaceRequest(options.request, url, headers, body);
}

export type GatewayRequestOptions = Omit<
  TargetRequestOptions,
  "target" | "devmateBaseURL" | "devmateNativeBaseURL" | "devmateApiKey"
> & {
  modelID?: string;
};

export async function prepareGatewayRequest(
  options: GatewayRequestOptions,
): Promise<Request> {
  return prepareRequestForTarget({
    ...options,
    catalogModelID: options.modelID,
    target: {
      provider: "gateway",
      model: options.modelID ?? "",
      protocol: options.adapter ? "native" : "compatible",
    },
  });
}

export async function prepareDevMateRequest(
  options: Omit<TargetRequestOptions, "target" | "gatewayApiKey"> & {
    modelID?: string;
  },
): Promise<Request> {
  return prepareRequestForTarget({
    ...options,
    catalogModelID: options.modelID,
    target: {
      provider: "devmate",
      model: options.modelID ?? "",
      protocol: options.adapter ? "native" : "compatible",
    },
  });
}

function gatewayFallback(
  modelID: string,
  routing: ModelRoutingOptions,
  selected: ModelRoutingEndpoint,
): ModelRoutingEndpoint {
  if (selected.provider !== "devmate") return selected;
  const rule = routing.models[modelID];
  if (rule?.within?.provider === "gateway") return rule.within;
  if (rule?.beyond.provider === "gateway") return rule.beyond;
  return { provider: "gateway", model: modelID };
}

function mergeRoutedModel(
  source: Record<string, unknown>,
  gatewayModel: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged = mergeRecordOverlay(source, gatewayModel ?? {});
  const gatewayPackage = gatewayModel?.package;
  if (gatewayPackage === undefined) {
    const { package: _package, ...withoutPackage } = merged;
    return withoutPackage;
  }
  return merged;
}

/** Select a target from the stable catalog model id, then prepare its request. */
export async function routeModelRequest(
  options: ModelRoutingRequestOptions,
): Promise<ModelRoutingRequestResult> {
  const selected = routeForModel(
    options.modelID,
    options.routing,
    options.now?.() ?? new Date(),
  );
  let target = selected;
  let devmateApiKey: string | undefined;
  if (selected.provider === "devmate") {
    devmateApiKey = await options.readApiKey();
    if (!devmateApiKey)
      target = gatewayFallback(options.modelID, options.routing, selected);
  }

  const requestTarget: RequestTarget = {
    ...target,
    protocol: options.adapter ? "native" : "compatible",
  };
  const request = await prepareRequestForTarget({
    ...options,
    catalogModelID: options.modelID,
    target: requestTarget,
    devmateApiKey,
    integrationID:
      target.provider === "gateway"
        ? options.gatewayIntegrationID
        : options.devmateIntegrationID,
    validateJSONBody: true,
  });
  return { request, target: target.provider, requestTarget };
}

export function addSharedModelDefaults(
  gatewayProvider: ProviderConfigLike,
  devmateProvider: ProviderConfigLike | undefined,
  routing: ModelRoutingOptions,
): ModelRoutingOptions {
  const gatewayModels = gatewayProvider.models ?? {};
  const devmateModels = devmateProvider?.models ?? {};
  const defaultModels = { ...routing.defaultModels };

  for (const modelId of Object.keys(gatewayModels)) {
    if (devmateModels[modelId] && !routing.models[modelId]) {
      defaultModels[modelId] ??= { provider: "devmate", model: modelId };
    }
  }

  return Object.keys(defaultModels).length > 0
    ? { ...routing, defaultModels }
    : routing;
}

/** Merge routed model metadata without changing the Gateway model package. */
export function mergeRoutedModels(
  gatewayProvider: ProviderConfigLike,
  devmateProvider: ProviderConfigLike | undefined,
  routing: ModelRoutingOptions,
): Record<string, Record<string, unknown>> {
  const gatewayModels = gatewayProvider.models ?? {};
  const devmateModels = devmateProvider?.models ?? {};
  const models = { ...gatewayModels };
  const modelIds = new Set([
    ...Object.keys(routing.models),
    ...Object.keys(routing.defaultModels ?? {}),
  ]);

  for (const modelID of modelIds) {
    const rule = routing.models[modelID];
    const within = rule?.within ?? routing.defaultModels?.[modelID];
    const beyond = rule?.beyond ?? within;
    if (!within || !beyond) continue;

    const preferred =
      within.provider === "devmate"
        ? devmateModels[within.model]
        : gatewayModels[within.model];
    const fallback =
      beyond.provider === "devmate"
        ? devmateModels[beyond.model]
        : gatewayModels[beyond.model];
    const source = preferred ?? fallback ?? gatewayModels[modelID];
    if (!source) continue;
    models[modelID] = mergeRoutedModel(source, gatewayModels[modelID]);
  }

  return models;
}

export type { ModelRoutingRule };
