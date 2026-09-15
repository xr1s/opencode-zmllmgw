/**
 * Declarative description of how to route one Gateway vendor's models
 * through that vendor's own native AI SDK package instead of the generic
 * OpenAI-compatible `/chat/completions` shape.
 *
 * Adding native routing for a new vendor means adding one entry to
 * {@link NATIVE_ADAPTERS} below — nothing else in this package needs
 * vendor-specific code. Every consumer loops over the registry generically:
 * `eligibilityToConfigModel()` in `model-mapping.ts` (sets the per-model
 * `package` override), and the catalog/request transforms in `plugin.ts`
 * (apply URL rewrites and extra per-request headers).
 */
import type { ConfigModelApi } from "./config/types.js";

export type NativeVendorAdapter = {
  /** Gateway vendor string this adapter applies to, e.g. `"anthropic"`. */
  vendor: string;
  /** Config-file API value that selects this native package. */
  api: Exclude<ConfigModelApi, "openai-completions">;
  /**
   * OpenCode AI package to load for this vendor's models
   * instead of `@opencode/ai/providers/openai-compatible`. This is the field that
   * actually matters — it's what OpenCode's `Provider` service reads to
   * decide which AI SDK package to load for a model.
   */
  package: string;
  /**
   * Model ids within this vendor confirmed (by testing against a live
   * Gateway instance) to reject the native endpoint while still working on
   * `/chat/completions`. Matching models are kept on the OpenAI-compatible
   * shape instead of getting this adapter's override.
   */
  unsupportedPattern?: RegExp;
  /**
   * Present only when this adapter's SDK calls a URL that the provider-level
   * `settings.baseURL` cannot express on its own
   * (e.g. Google's native endpoint needs a `/v1beta` path segment after the
   * existing `/v1` base path). When set, the plugin's `http.request` hook
   * rewrites matching outgoing request URLs.
   */
  rewriteURL?: {
    /** Matches the unrewritten request URL this adapter's SDK will call. */
    pathPattern: RegExp;
    /** Segment inserted right after `baseURL` when `pathPattern` matches. */
    insertSegment: string;
  };
  /** Whether the native protocol carries the backend model ID in its JSON body. */
  modelInBody?: boolean;
  /** Replace a backend model ID encoded in a native request URL. */
  replaceModelURL?: (
    url: string,
    sourceModelID: string,
    targetModelID: string,
  ) => string;
  /**
   * Extra headers this adapter's SDK needs beyond its own defaults to
   * authenticate against Gateway correctly (e.g. `@opencode/ai/providers/google` defaults
   * to a header Gateway rejects). Called for every request routed through
   * this adapter's `package`. Receives the Gateway
   * personal API key when the caller has one available.
   */
  headers?: (ctx: { apiKey?: string }) => Record<string, string>;
};

/** AI SDK package used for Anthropic-vendor Gateway models. */
export const ANTHROPIC_NATIVE_PACKAGE = "@opencode/ai/providers/anthropic";
/** AI SDK package used for OpenAI-vendor Gateway chat models. */
export const OPENAI_NATIVE_PACKAGE = "@opencode/ai/providers/openai";
/** AI SDK package used for Google-vendor Gateway chat models. */
export const GOOGLE_NATIVE_PACKAGE = "@opencode/ai/providers/google";

/** Matches Google's native `generateContent`/`streamGenerateContent` request paths. */
const GOOGLE_GENERATE_CONTENT_PATH =
  /:(?:generateContent|streamGenerateContent)(?:\?|$)/;

function replaceGoogleModelURL(
  url: string,
  sourceModelID: string,
  targetModelID: string,
): string {
  const input = new URL(url);
  const segments = input.pathname.split("/");
  const modelsIndex = segments.lastIndexOf("models");
  const modelSegment = modelsIndex >= 0 ? segments[modelsIndex + 1] : undefined;
  if (!modelSegment) return url;

  const separator = modelSegment.indexOf(":");
  const modelPart =
    separator === -1 ? modelSegment : modelSegment.slice(0, separator);
  if (decodeURIComponent(modelPart) !== sourceModelID) return url;

  const action = separator === -1 ? "" : modelSegment.slice(separator);
  segments[modelsIndex + 1] = `${encodeURIComponent(targetModelID)}${action}`;
  input.pathname = segments.join("/");
  return input.toString();
}

export const NATIVE_ADAPTERS: NativeVendorAdapter[] = [
  /**
   * Routing Anthropic-vendor models through the native Anthropic Messages
   * API — which Gateway also exposes, at `/v1/messages` — unlocks
   * capabilities the OpenAI-compatible `/chat/completions` shape cannot
   * represent: automatic prompt caching, extended/adaptive thinking with
   * medium/high/xhigh effort variants, native tool-use schemas, and
   * `cache_control` breakpoints. OpenCode's own `ProviderTransform` module
   * already contains all of the logic for these — it activates purely
   * based on the model package — so this adapter
   * only needs to set that per-model override. Its native endpoint lives
   * at the same base URL as the OpenAI-compatible one, so no `rewriteURL`
   * is needed. Authentication also carries over unchanged: `@opencode/ai/providers/anthropic`
   * sends the Gateway personal API key as `x-api-key`, which Gateway
   * already accepts by default (confirmed by testing).
   */
  {
    vendor: "anthropic",
    api: "anthropic-messages",
    package: ANTHROPIC_NATIVE_PACKAGE,
  },
  /**
   * Routing OpenAI-vendor chat models through `@opencode/ai/providers/openai`'s Responses
   * API implementation — which Gateway also exposes, at `/v1/responses` —
   * unlocks: encrypted reasoning items that persist chain-of-thought
   * across multi-turn tool calls (via `include:
   * ["reasoning.encrypted_content"]`), auto reasoning summaries, and the
   * full per-model reasoning-effort variant set OpenCode's
   * `ProviderTransform` maintains for `@opencode/ai/providers/openai` (`minimal`/`none`/
   * `xhigh` where the specific GPT-5.x generation supports them, beyond
   * the generic `low`/`medium`/`high` used for the OpenAI-compatible
   * shape). It also sidesteps a `max_tokens` incompatibility some GPT-5.x
   * models have on `/chat/completions`.
   *
   * A handful of OpenAI-vendor models are confirmed (by testing against a
   * live Gateway instance) to reject `/v1/responses` while working fine on
   * `/v1/chat/completions` — audio/TTS models and the Perplexity-style
   * "search" models, which must stay on the compatible endpoint. Those are
   * excluded via `unsupportedPattern`.
   */
  {
    vendor: "openai",
    api: "openai-responses",
    package: OPENAI_NATIVE_PACKAGE,
    unsupportedPattern: /(-tts$|search-preview$|search-api$)/,
  },
  /**
   * Routing Google-vendor chat models through `@opencode/ai/providers/google`'s native
   * `generateContent`/`streamGenerateContent` implementation — which
   * Gateway also exposes, at `/v1/v1beta/models/<id>:generateContent` — fixes
   * a real correctness bug seen on the OpenAI-compatible shape: requesting
   * a bounded `max_tokens` on a reasoning-capable Gemini model (e.g.
   * `gemini-2.5-pro`) can consume the entire budget on hidden thinking
   * tokens and return `content: null` with `finish_reason: "length"` — the
   * caller has no way to see or control this. The native
   * `thinkingConfig.includeThoughts` OpenCode sets for `@opencode/ai/providers/google`
   * instead surfaces thinking as an explicit, separate part of the
   * response (confirmed by testing against a live Gateway instance).
   *
   * Unlike the other two adapters, Google's native endpoint needs a
   * `/v1beta` path segment after Gateway's existing `/v1` base path, and
   * OpenCode's `Provider`
   * service otherwise ignores any per-model base URL override — so this
   * adapter also declares
   * `rewriteURL`, which the plugin's `http.request` hook uses to rewrite
   * outgoing requests accordingly.
   *
   * Gateway also does not accept `@opencode/ai/providers/google`'s default
   * `x-goog-api-key` authentication header for the personal API key flow
   * (confirmed by testing: sending only `x-goog-api-key` returns `401 Not
   * authenticated`, even with a valid key value) — so this adapter also
   * declares `headers`, which the plugin's `http.request` hook uses to add
   * `x-api-key` per request. `x-goog-api-key` is still sent by the SDK but
   * silently ignored by Gateway, so nothing needs to suppress it.
   *
   * A handful of Google-vendor models are confirmed to reject the native
   * endpoint while working on `/chat/completions` — Gemma models, newer
   * image-generation models, and the realtime/live audio model. Those are
   * excluded via `unsupportedPattern`.
   */
  {
    vendor: "google",
    api: "google-generative-ai",
    package: GOOGLE_NATIVE_PACKAGE,
    unsupportedPattern: /(?:gemma|-image-preview$|^gemini-live-)/i,
    rewriteURL: {
      pathPattern: GOOGLE_GENERATE_CONTENT_PATH,
      insertSegment: "/v1beta",
    },
    modelInBody: false,
    replaceModelURL: replaceGoogleModelURL,
    headers: ({ apiKey }): Record<string, string> => {
      if (!apiKey) return {};
      return { "x-api-key": apiKey };
    },
  },
];

/**
 * Looks up the native adapter for a Gateway vendor, applying the adapter's
 * own unsupported-model exclusion.
 */
export function findNativeAdapter(
  vendor: string,
  id: string,
): NativeVendorAdapter | undefined {
  const adapter = NATIVE_ADAPTERS.find((entry) => entry.vendor === vendor);
  if (!adapter) return undefined;
  if (adapter.unsupportedPattern?.test(id)) return undefined;
  return adapter;
}

/** Map the explicit config API enum to the same package registry used by discovery. */
export function packageForConfigApi(api: ConfigModelApi): string | undefined {
  if (api === "openai-completions") return undefined;
  return NATIVE_ADAPTERS.find((entry) => entry.api === api)?.package;
}

/** Looks up the native adapter whose package matches a model package value. */
export function findNativeAdapterByPackage(
  packageName: string,
): NativeVendorAdapter | undefined {
  return NATIVE_ADAPTERS.find((entry) => entry.package === packageName);
}

/** Rewrite a native request URL for an adapter's endpoint shape. */
export function rewriteURLWithPathInsert(
  baseURL: string,
  rule: { pathPattern: RegExp; insertSegment: string },
  url: string,
): string {
  const input = new URL(url);
  const base = new URL(baseURL);
  if (input.origin !== base.origin || !rule.pathPattern.test(input.toString()))
    return url;

  const basePath = base.pathname.replace(/\/+$/, "") || "/";
  if (input.pathname !== basePath && !input.pathname.startsWith(`${basePath}/`))
    return url;

  const suffix = input.pathname
    .slice(basePath === "/" ? 0 : basePath.length)
    .replace(/^\/+/, "");
  const insert = rule.insertSegment.replace(/^\/+|\/+$/g, "");
  base.pathname =
    `${basePath === "/" ? "" : basePath}/${insert}${suffix ? `/${suffix}` : ""}` ||
    "/";
  base.search = input.search;
  base.hash = input.hash;
  return base.toString();
}
