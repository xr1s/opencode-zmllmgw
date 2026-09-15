import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  fetchDevMateModels,
  toDevMateConfigModel,
  toDevMateConfigModels,
} from "../src/devmate-models.js";

const baseURL = "https://devmate.example/api/v1/llm-proxy/v1";

test("fetchDevMateModels parses the model list and sends Bearer auth", async () => {
  let seenURL: string | undefined;
  let seenHeaders: Headers | undefined;
  const models = await fetchDevMateModels({
    baseURL,
    apiKey: "devmate-key",
    fetch: async (input, init) => {
      seenURL = String(input);
      seenHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ id: "dev-model", owned_by: "acme" }],
        }),
      );
    },
  });

  assert.equal(seenURL, `${baseURL}/models`);
  assert.equal(seenHeaders?.get("authorization"), "Bearer devmate-key");
  assert.deepEqual(models, [{ id: "dev-model", owned_by: "acme" }]);
});

test("toDevMateConfigModel uses V2 capabilities and limits", () => {
  assert.deepEqual(
    toDevMateConfigModel({
      id: "vision-model",
      context_length: 32768,
      max_output_tokens: 8192,
      capabilities: ["tools", "vision", "reasoning"],
    }),
    {
      name: "vision-model",
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      limit: { context: 32768, output: 8192 },
      variants: [
        { id: "low", settings: { reasoningEffort: "low" } },
        { id: "medium", settings: { reasoningEffort: "medium" } },
        { id: "high", settings: { reasoningEffort: "high" } },
        { id: "max", settings: { reasoningEffort: "max" } },
      ],
    },
  );
});

test("toDevMateConfigModels uses compatible reasoning defaults without metadata", () => {
  const models = toDevMateConfigModels([{ id: "chat-model" }]);
  assert.equal(models["chat-model"].capabilities.tools, true);
  assert.deepEqual(models["chat-model"].capabilities.input, ["text"]);
  assert.deepEqual(
    models["chat-model"].variants?.map((variant) => variant.id),
    ["low", "medium", "high", "max"],
  );
});
