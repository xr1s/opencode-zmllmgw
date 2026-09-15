export type ConfigModel = {
  name: string;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  limit: { context: number; output: number };
  package?: string;
  variants?: Array<{ id: string; settings: Record<string, unknown> }>;
};

export type ModelCapabilities = {
  name: string;
  toolCall: boolean;
  vision: boolean;
  context: number;
  output: number;
  package?: string;
  variants?: ConfigModel["variants"];
};

export const DEFAULT_CONTEXT_LENGTH = 128000;

export type ReasoningVariantAPI =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

type ReasoningVariants = NonNullable<ConfigModel["variants"]>;

export const REASONING_VARIANTS_BY_API = {
  "openai-completions": [
    { id: "low", settings: { reasoningEffort: "low" } },
    { id: "medium", settings: { reasoningEffort: "medium" } },
    { id: "high", settings: { reasoningEffort: "high" } },
    { id: "max", settings: { reasoningEffort: "max" } },
  ],
  "openai-responses": [
    { id: "minimal", settings: { reasoningEffort: "minimal" } },
    { id: "low", settings: { reasoningEffort: "low" } },
    { id: "medium", settings: { reasoningEffort: "medium" } },
    { id: "high", settings: { reasoningEffort: "high" } },
    { id: "xhigh", settings: { reasoningEffort: "xhigh" } },
    { id: "max", settings: { reasoningEffort: "max" } },
  ],
  "anthropic-messages": [
    { id: "low", settings: { effort: "low" } },
    { id: "medium", settings: { effort: "medium" } },
    { id: "high", settings: { effort: "high" } },
    { id: "xhigh", settings: { effort: "xhigh" } },
    { id: "max", settings: { effort: "max" } },
  ],
  "google-generative-ai": [
    {
      id: "minimal",
      settings: { thinkingConfig: { thinkingLevel: "minimal" } },
    },
    { id: "low", settings: { thinkingConfig: { thinkingLevel: "low" } } },
    {
      id: "medium",
      settings: { thinkingConfig: { thinkingLevel: "medium" } },
    },
    { id: "high", settings: { thinkingConfig: { thinkingLevel: "high" } } },
  ],
} satisfies Record<ReasoningVariantAPI, ReasoningVariants>;

const REASONING_SETTING_BY_API: Record<
  ReasoningVariantAPI,
  "reasoningEffort" | "effort" | "thinkingLevel"
> = {
  "openai-completions": "reasoningEffort",
  "openai-responses": "reasoningEffort",
  "anthropic-messages": "effort",
  "google-generative-ai": "thinkingLevel",
};

export function reasoningVariantsForAPI(
  api: ReasoningVariantAPI,
  efforts?: readonly string[],
): ReasoningVariants {
  if (!efforts) return REASONING_VARIANTS_BY_API[api];
  const setting = REASONING_SETTING_BY_API[api];
  return efforts.map((effort) => ({
    id: effort,
    settings:
      setting === "thinkingLevel"
        ? { thinkingConfig: { thinkingLevel: effort } }
        : { [setting]: effort },
  }));
}

export function defaultConfigModel(name: string): ConfigModel {
  return buildConfigModel({
    name,
    toolCall: false,
    vision: false,
    context: DEFAULT_CONTEXT_LENGTH,
    output: inferOutputLimit(DEFAULT_CONTEXT_LENGTH),
  });
}

export function inferOutputLimit(contextLength: number): number {
  if (contextLength >= 400000) return 131072;
  if (contextLength >= 128000) return 65536;
  if (contextLength >= 32000) return 16384;
  return 4096;
}

/** Build the shared OpenCode model shape from backend-specific capabilities. */
export function buildConfigModel(capabilities: ModelCapabilities): ConfigModel {
  const {
    name,
    toolCall,
    vision,
    context,
    output,
    package: modelPackage,
    variants,
  } = capabilities;

  return {
    name,
    capabilities: {
      tools: toolCall,
      input: vision ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    limit: { context, output },
    ...(modelPackage ? { package: modelPackage } : {}),
    ...(variants ? { variants } : {}),
  };
}
