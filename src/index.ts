import { model as openAICompatibleModel } from "@opencode/ai/providers/openai-compatible";
import type { ProviderPackageSettings } from "@opencode/ai";
import plugin from "./plugin.js";

/**
 * V2 provider entrypoint. OpenCode supplies the provider's flat `settings`
 * object for every selected model; request-time authentication and Gateway
 * fields are added by the companion plugin's HTTP hook.
 */
export function model(
  modelID: string,
  settings: ProviderPackageSettings & Record<string, unknown>,
) {
  const { baseURL, apiKey, headers, body, ...providerOptions } = settings;
  if (typeof baseURL !== "string" || !baseURL) {
    throw new Error("ZMLLMGW: `settings.baseURL` is required");
  }

  return openAICompatibleModel(modelID, {
    ...providerOptions,
    baseURL,
    ...(typeof apiKey === "string" ? { apiKey } : {}),
    ...(headers ? { headers } : {}),
    ...(body ? { body } : {}),
  });
}

export type {
  ModelRoutingOptions,
  ModelRoutingRule,
  ModelRoutingEndpoint,
  ModelRoutingTimeWindow,
} from "./options.js";

/** Default V2 plugin export used when the package is listed in `plugins`. */
export default plugin;
