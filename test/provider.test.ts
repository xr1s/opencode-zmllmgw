import { strict as assert } from "node:assert";
import { test } from "node:test";
import plugin, { model } from "../src/index.js";
import { stripRateLimitRetryAfter } from "../src/request.js";
import { prepareGatewayRequest } from "../src/model-routing.js";

const baseURL = "https://gateway.example/v1";

test("stripRateLimitRetryAfter leaves non-rate-limit responses unchanged", () => {
  const response = new Response("ok", {
    status: 200,
    headers: { "retry-after": "60" },
  });
  assert.equal(stripRateLimitRetryAfter(response), response);
});

test("Gateway request preparation adds only protocol correlation fields", async () => {
  const request = await prepareGatewayRequest({
    request: new Request(`${baseURL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "model-a", messages: [] }),
    }),
    sourceBaseURL: baseURL,
    gatewayBaseURL: baseURL,
    modelID: "model-a",
    sessionID: "ses_provider",
    gatewayApiKey: "gateway-key",
    integrationID: "zmllmgw",
  });
  assert.equal(request.headers.get("x-api-key"), "gateway-key");
  assert.equal(request.headers.get("llm-settings"), null);
  assert.deepEqual(await request.json(), {
    model: "model-a",
    messages: [],
    task_id: "ses_provider",
  });
});

test("V2 provider model uses the OpenCode OpenAI-compatible runtime", () => {
  const selected = model("claude-opus-5", { baseURL });
  assert.equal(selected.provider, "openai-compatible");
});

test("V2 provider model forwards selected variant request options", () => {
  const selected = model("deepseek_v4_flash", {
    baseURL,
    reasoningEffort: "high",
  });
  assert.deepEqual(selected.route.defaults?.providerOptions, {
    reasoningEffort: "high",
  });
});

test("V2 package root exports the plugin by default", () => {
  assert.equal(plugin.id, "opencode-zmllmgw");
});

test("V2 provider requires settings.baseURL", () => {
  assert.throws(() => model("claude-opus-5", {} as never), /settings.baseURL/);
});
