import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  eligibilityToConfigModel,
  eligibilityToConfigModels,
} from "../src/model-mapping.js";
import {
  ANTHROPIC_NATIVE_PACKAGE,
  GOOGLE_NATIVE_PACKAGE,
  OPENAI_NATIVE_PACKAGE,
} from "../src/native-adapters.js";

type Eligibility = Parameters<typeof eligibilityToConfigModel>[0];

function eligibility(
  modelName: string,
  overrides: Record<string, unknown> = {},
): Eligibility {
  return {
    client_model_config: {
      client_model_config_id: 0,
      model_name: modelName,
      vendor: "",
      context_length: 0,
      modality: "",
      providers: [{ model_provider: `${modelName}/${modelName}` }],
      ...overrides,
    },
  };
}

test("eligibilityToConfigModel infers V2 capabilities and native package", () => {
  const model = eligibilityToConfigModel(
    eligibility("gpt-5", { vendor: "openai", context_length: 1000000 }),
  )!;
  assert.deepEqual(model, {
    name: "gpt-5",
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    limit: { context: 1000000, output: 131072 },
    package: OPENAI_NATIVE_PACKAGE,
    variants: [
      { id: "minimal", settings: { reasoningEffort: "minimal" } },
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "medium", settings: { reasoningEffort: "medium" } },
      { id: "high", settings: { reasoningEffort: "high" } },
      { id: "xhigh", settings: { reasoningEffort: "xhigh" } },
      { id: "max", settings: { reasoningEffort: "max" } },
    ],
  });
});

test("native adapters select the V2 package names", () => {
  assert.equal(
    eligibilityToConfigModel(
      eligibility("claude-sonnet-5", { vendor: "anthropic" }),
    )?.package,
    ANTHROPIC_NATIVE_PACKAGE,
  );
  assert.equal(
    eligibilityToConfigModel(
      eligibility("gemini-2.5-pro", { vendor: "google" }),
    )?.package,
    GOOGLE_NATIVE_PACKAGE,
  );
  assert.equal(
    eligibilityToConfigModel(
      eligibility("gpt-4o-mini-tts", { vendor: "openai" }),
    )?.package,
    undefined,
  );
  assert.equal(
    eligibilityToConfigModel(
      eligibility("google_gemma_4_31b_it", { vendor: "google" }),
    )?.package,
    undefined,
  );
});

test("native Anthropic and Google models receive provider-specific variants", () => {
  const anthropic = eligibilityToConfigModel(
    eligibility("claude-opus-5", { vendor: "anthropic" }),
  )!;
  assert.deepEqual(anthropic.variants, [
    { id: "low", settings: { effort: "low" } },
    { id: "medium", settings: { effort: "medium" } },
    { id: "high", settings: { effort: "high" } },
    { id: "xhigh", settings: { effort: "xhigh" } },
    { id: "max", settings: { effort: "max" } },
  ]);

  const google = eligibilityToConfigModel(
    eligibility("gemini-3.1-pro", { vendor: "google" }),
  )!;
  assert.deepEqual(google.variants, [
    {
      id: "minimal",
      settings: { thinkingConfig: { thinkingLevel: "minimal" } },
    },
    { id: "low", settings: { thinkingConfig: { thinkingLevel: "low" } } },
    { id: "medium", settings: { thinkingConfig: { thinkingLevel: "medium" } } },
    { id: "high", settings: { thinkingConfig: { thinkingLevel: "high" } } },
  ]);
});

test("profile-provided reasoning efforts override the vendor defaults", () => {
  const model = eligibilityToConfigModel(
    eligibility("gpt-5", {
      vendor: "openai",
      reasoning_efforts: ["low", "high"],
    }),
  )!;
  assert.deepEqual(model.variants, [
    { id: "low", settings: { reasoningEffort: "low" } },
    { id: "high", settings: { reasoningEffort: "high" } },
  ]);
});

test("reasoning OpenAI-compatible models receive array variants", () => {
  const model = eligibilityToConfigModel(
    eligibility("deepseek_v4_flash", { vendor: "acme" }),
  )!;
  assert.equal(model.capabilities.tools, true);
  assert.deepEqual(model.variants, [
    { id: "low", settings: { reasoningEffort: "low" } },
    { id: "medium", settings: { reasoningEffort: "medium" } },
    { id: "high", settings: { reasoningEffort: "high" } },
    { id: "max", settings: { reasoningEffort: "max" } },
  ]);
  assert.equal(model.package, undefined);
});

test("eligibilityToConfigModels filters vendors while preserving included ids", () => {
  const models = eligibilityToConfigModels(
    [
      eligibility("gpt-5", { vendor: "openai" }),
      eligibility("claude-sonnet-5", { vendor: "anthropic" }),
    ],
    { vendors: ["openai"], include: ["claude-sonnet-5"] },
  );
  assert.deepEqual(Object.keys(models).sort(), ["claude-sonnet-5", "gpt-5"]);
});

test("eligibilityToConfigModel derives vendor from provider prefix", () => {
  const model = eligibilityToConfigModel(
    eligibility("deepseek_v4_flash", {
      providers: [{ model_provider: "acme/deepseek-v4-flash-0731" }],
    }),
  )!;
  assert.ok(model.variants);
});
