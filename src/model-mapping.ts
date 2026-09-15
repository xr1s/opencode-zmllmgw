/**
 * Maps the llm-admin workspace model profile (`current_eligibility`) into the
 * model shape OpenCode's catalog uses. Vendor-specific capability inference
 * stays here; the final ConfigModel shape is built by `model-config.ts` and is
 * shared with DevMate discovery.
 */

import type { ClientModelConfig, EligibilityEntry } from "./admin-client.js";
import { findNativeAdapter } from "./native-adapters.js";
import {
  buildConfigModel,
  DEFAULT_CONTEXT_LENGTH,
  inferOutputLimit,
  reasoningVariantsForAPI,
  type ConfigModel,
} from "./model-config.js";

export type VendorProfile = {
  vendor: string;
  reasoningPatterns?: RegExp[];
  visionPatterns?: RegExp[];
  toolCall?: boolean | RegExp;
};

const VENDOR_PROFILES: VendorProfile[] = [
  {
    vendor: "openai",
    reasoningPatterns: [/^o[0-9]/, /^gpt-5(?!.*chat-latest)/],
    visionPatterns: [/^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o1|o3|o4)/],
    toolCall: true,
  },
  {
    vendor: "anthropic",
    reasoningPatterns: [/(sonnet|opus|haiku)-(4|5)/, /-(latest)$/],
    visionPatterns: [/^claude-/],
    toolCall: true,
  },
  {
    vendor: "google",
    reasoningPatterns: [
      /gemini-(2\.5-pro|2\.5-flash$|3[.\d]*-pro|3[.\d]*-flash$)/,
    ],
    visionPatterns: [/^gemini-(?!live)/],
    toolCall: true,
  },
  {
    vendor: "perplexity",
    reasoningPatterns: [/^sonar-reasoning/],
    toolCall: true,
  },
  {
    vendor: "aws_openai",
    reasoningPatterns: [/^(zai\.|moonshotai\.)/],
    toolCall: true,
  },
  {
    vendor: "oci_openai",
    reasoningPatterns: [/^xai\.grok-.*reasoning$/],
    toolCall: true,
  },
];

function profileFor(vendor: string): VendorProfile | undefined {
  return VENDOR_PROFILES.find((profile) => profile.vendor === vendor);
}

const NO_VISION_OVERRIDE = /(instruct|-tts|search-preview|search-api|live-)/;

/** Unknown vendors default to reasoning enabled; known vendors use their profile. */
function inferReasoning(vendor: string, id: string): boolean {
  const profile = profileFor(vendor);
  if (!profile) return true;
  return (
    profile.reasoningPatterns?.some((pattern) => pattern.test(id)) ?? false
  );
}

function inferVision(vendor: string, id: string): boolean {
  if (NO_VISION_OVERRIDE.test(id)) return false;
  return (
    profileFor(vendor)?.visionPatterns?.some((pattern) => pattern.test(id)) ??
    false
  );
}

/** Unknown vendors default to tool-call enabled; known vendors use their profile. */
function inferToolCall(vendor: string, id: string): boolean {
  const profile = profileFor(vendor);
  if (!profile) return true;
  const toolCall = profile.toolCall;
  if (toolCall === true) return true;
  if (toolCall instanceof RegExp) return toolCall.test(id);
  return false;
}

type ProfileReasoning = {
  enabled?: boolean;
  efforts?: string[];
};

const REASONING_EFFORT_KEYS = [
  "reasoning_efforts",
  "reasoningEfforts",
  "supported_reasoning_efforts",
  "supportedReasoningEfforts",
  "thinking_levels",
  "thinkingLevels",
  "supported_thinking_levels",
  "supportedThinkingLevels",
];

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return values;
}

function profileReasoning(value: unknown, depth = 0): ProfileReasoning {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;

  for (const key of REASONING_EFFORT_KEYS) {
    const efforts = stringList(record[key]);
    if (efforts) return { efforts };
  }

  for (const key of ["reasoning", "supports_reasoning", "supportsReasoning"]) {
    if (typeof record[key] === "boolean") return { enabled: record[key] };
  }

  if (depth >= 2) return {};
  for (const key of ["reasoning", "thinking", "capabilities"]) {
    const nested = profileReasoning(record[key], depth + 1);
    if (nested.efforts || nested.enabled !== undefined) return nested;
  }
  return {};
}

function profileReasoningFor(config: ClientModelConfig): ProfileReasoning {
  const direct = profileReasoning(config);
  if (direct.efforts || direct.enabled !== undefined) return direct;

  if (typeof config.metadata_json === "string") {
    try {
      return profileReasoning(JSON.parse(config.metadata_json));
    } catch {
      return {};
    }
  }
  return {};
}

const PROVIDER_PREFIX_VENDORS: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  bedrock: "aws_openai",
  aws: "aws_openai",
  vertex: "google",
  perplexity: "perplexity",
  mistral: "mistral",
  oracle: "oci_openai",
};

function vendorForEligibility(config: ClientModelConfig): string {
  if (config.vendor) return config.vendor;
  const provider = config.providers?.[0]?.model_provider;
  if (!provider) return "";

  const slash = provider.indexOf("/");
  if (slash <= 0) return "";
  return PROVIDER_PREFIX_VENDORS[provider.slice(0, slash)] ?? "";
}

/** Map one admin-API eligibility entry into the OpenCode model shape. */
export function eligibilityToConfigModel(
  entry: EligibilityEntry,
): ConfigModel | undefined {
  const config = entry.client_model_config;
  if (!config || typeof config.model_name !== "string" || !config.model_name)
    return undefined;

  const id = config.model_name;
  const context =
    config.context_length && config.context_length > 0
      ? config.context_length
      : DEFAULT_CONTEXT_LENGTH;
  const vendor = vendorForEligibility(config);
  const vision =
    inferVision(vendor, id) ||
    /^.*(->image|image.*->)/i.test(config.modality ?? "");
  const profile = profileReasoningFor(config);
  const reasoning = profile.enabled ?? inferReasoning(vendor, id);
  const adapter = findNativeAdapter(vendor, id);
  const reasoningAPI = adapter?.api ?? "openai-completions";

  return buildConfigModel({
    name: config.display_name || id,
    toolCall: inferToolCall(vendor, id),
    vision,
    context,
    output: inferOutputLimit(context),
    package: adapter?.package,
    variants: reasoning
      ? reasoningVariantsForAPI(reasoningAPI, profile.efforts)
      : undefined,
  });
}

export function eligibilityToConfigModels(
  eligibility: EligibilityEntry[],
  params: {
    vendors?: readonly string[];
    include?: readonly string[];
  },
): Record<string, ConfigModel> {
  const out: Record<string, ConfigModel> = {};
  const vendors = params.vendors?.length ? new Set(params.vendors) : undefined;
  const include = new Set(params.include ?? []);

  for (const entry of eligibility) {
    const id = entry.client_model_config?.model_name;
    const vendor = entry.client_model_config
      ? vendorForEligibility(entry.client_model_config)
      : "";
    if (id && vendors && !vendors.has(vendor) && !include.has(id)) continue;

    const model = eligibilityToConfigModel(entry);
    if (model && id) out[id] = model;
  }
  return out;
}
