import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildConfigModel,
  REASONING_VARIANTS_BY_API,
} from "../src/model-config.js";

const base = {
  name: "test-model",
  toolCall: true,
  reasoning: true,
  vision: false,
  context: 128000,
  output: 4096,
};

test("buildConfigModel does not infer variants from an unrelated provider field", () => {
  const model = buildConfigModel({
    ...base,
    package: "@opencode/ai/providers/openai",
  });

  assert.equal(model.variants, undefined);
  assert.equal(model.package, "@opencode/ai/providers/openai");
});

test("buildConfigModel keeps variants explicit", () => {
  const model = buildConfigModel({
    ...base,
    variants: REASONING_VARIANTS_BY_API["openai-completions"],
  });

  assert.deepEqual(
    model.variants,
    REASONING_VARIANTS_BY_API["openai-completions"],
  );
});
