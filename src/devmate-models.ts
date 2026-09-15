import {
  buildConfigModel,
  DEFAULT_CONTEXT_LENGTH,
  reasoningVariantsForAPI,
  type ConfigModel,
} from "./model-config.js";

export type DevMateModel = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  context_length?: number;
  max_output_tokens?: number;
  tool_call?: boolean;
  reasoning?: boolean;
  vision?: boolean;
  capabilities?: string[];
  [key: string]: unknown;
};

export type DevMateModelsResponse = {
  object?: string;
  data?: DevMateModel[];
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const DEVMATE_REASONING_PATTERN = /(?:deepseek[_-]v4|deepseek-reasoner)/i;

function modelListFromResponse(body: unknown): DevMateModel[] {
  const data = Array.isArray(body)
    ? body
    : (body as DevMateModelsResponse | null)?.data;
  if (!Array.isArray(data))
    throw new Error("DevMate: unexpected /models response shape");

  return data.filter((model): model is DevMateModel =>
    Boolean(
      model &&
      typeof model === "object" &&
      typeof model.id === "string" &&
      model.id,
    ),
  );
}

export async function fetchDevMateModels(params: {
  baseURL: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<DevMateModel[]> {
  const fetchImpl = params.fetch ?? globalThis.fetch;
  const url = `${params.baseURL.replace(/\/+$/, "")}/models`;
  const signal =
    params.signal ?? AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      "user-agent": "",
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `DevMate: failed to list models (${response.status} ${response.statusText})`,
    );
  }
  return modelListFromResponse((await response.json()) as unknown);
}

function hasCapability(model: DevMateModel, capability: string): boolean {
  return (
    model.capabilities?.some((entry) => entry.toLowerCase() === capability) ??
    false
  );
}

const REASONING_EFFORT_KEYS = [
  "reasoning_efforts",
  "reasoningEfforts",
  "supported_reasoning_efforts",
  "supportedReasoningEfforts",
];

function reasoningEfforts(model: DevMateModel): string[] | undefined {
  for (const key of REASONING_EFFORT_KEYS) {
    const value = model[key];
    if (!Array.isArray(value)) continue;
    return value.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
  }
  return undefined;
}

export function toDevMateConfigModel(
  model: DevMateModel,
  options: { toolCall?: boolean } = {},
): ConfigModel {
  const context =
    typeof model.context_length === "number" && model.context_length > 0
      ? model.context_length
      : DEFAULT_CONTEXT_LENGTH;
  const output =
    typeof model.max_output_tokens === "number" && model.max_output_tokens > 0
      ? model.max_output_tokens
      : context >= 128000
        ? 65536
        : 4096;
  const toolCall =
    typeof model.tool_call === "boolean"
      ? model.tool_call
      : model.capabilities
        ? hasCapability(model, "tools") || hasCapability(model, "tool_call")
        : (options.toolCall ?? true);
  const vision =
    typeof model.vision === "boolean"
      ? model.vision
      : hasCapability(model, "vision");
  const reasoning =
    typeof model.reasoning === "boolean"
      ? model.reasoning
      : model.capabilities
        ? hasCapability(model, "reasoning") ||
          DEVMATE_REASONING_PATTERN.test(model.id)
        : true;
  const efforts = reasoningEfforts(model);

  return buildConfigModel({
    name: model.id,
    toolCall,
    vision,
    context,
    output,
    variants: reasoning
      ? reasoningVariantsForAPI("openai-completions", efforts)
      : undefined,
  });
}

export function toDevMateConfigModels(
  models: DevMateModel[],
  options: { toolCall?: boolean } = {},
): Record<string, ConfigModel> {
  const result: Record<string, ConfigModel> = {};
  for (const model of models)
    result[model.id] = toDevMateConfigModel(model, options);
  return result;
}
