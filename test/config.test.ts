import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/loader.js";
import {
  devmateBaseURL,
  gatewayBaseURL,
  gatewayNativeBaseURL,
  routingFromConfig,
  staticModelOverlays,
} from "../src/config/mapping.js";

async function configFile(extension: string, content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zmllmgw-config-"));
  const path = join(directory, `config.${extension}`);
  await writeFile(path, content);
  return path;
}

test("loadConfig parses YAML and resolves provider endpoints and model routes", async () => {
  const path = await configFile(
    "yaml",
    `
providers:
  gateway:
    endpoint: https://gateway.example
  devmate:
    endpoint: https://devmate.example/proxy
cache:
  ttl: 24h
models:
  - gatewayId: model-a
    devmateId: dev-model-a
    api: openai-completions
    tools: true
    schedule:
      timezone: UTC
      windows: []
      beyond: devmate
`,
  );
  const loaded = await loadConfig(path);
  assert.equal(loaded.config?.cache.ttl, "24h");
  assert.equal(loaded.config?.providers.gateway.id, "zmllmgw");
  assert.equal(loaded.config?.providers.devmate?.id, "zmdevmate");
  assert.equal(gatewayBaseURL(loaded.config!), "https://gateway.example/v1");
  assert.equal(
    gatewayNativeBaseURL(loaded.config!),
    "https://gateway.example/v1",
  );
  assert.equal(
    devmateBaseURL(loaded.config!),
    "https://devmate.example/proxy/v1",
  );
  assert.deepEqual(routingFromConfig(loaded.config!), {
    devmateBaseURL: "https://devmate.example/proxy/v1",
    models: {
      "model-a": {
        timezone: "UTC",
        windows: [],
        beyond: { provider: "devmate", model: "dev-model-a" },
      },
    },
  });
  assert.deepEqual(staticModelOverlays(loaded.config!), {
    "model-a": { capabilities: { tools: true }, package: undefined },
  });
});

test("loadConfig resolves a configured provider id override", async () => {
  const path = await configFile(
    "yaml",
    `
providers:
  gateway:
    id: my-gw
    endpoint: https://gateway.example
  devmate:
    id: my-dm
    endpoint: https://devmate.example
models: []
`,
  );
  const loaded = await loadConfig(path);
  assert.equal(loaded.config?.providers.gateway.id, "my-gw");
  assert.equal(loaded.config?.providers.devmate?.id, "my-dm");
});

test("loadConfig parses JSONC and ignores unknown fields", async () => {
  const path = await configFile(
    "json",
    `{
  // comments are accepted for .json files
  "providers": { "gateway": { "endpoint": "https://gateway.example" } },
  "unknown": true,
  "models": [{ "gatewayId": "model-a", "unknown": "ignored" }],
}`,
  );
  const loaded = await loadConfig(path);
  assert.deepEqual(loaded.config?.models, [
    { gatewayId: "model-a", devmateId: "model-a" },
  ]);
});

test("loadConfig rejects invalid known fields with a field path", async () => {
  const path = await configFile(
    "yaml",
    `
providers:
  gateway:
    endpoint: https://gateway.example
models:
  - gatewayId: model-a
    schedule:
      windows: []
      beyond: invalid
`,
  );
  await assert.rejects(loadConfig(path), /models\[0\]\.schedule\.beyond/);
});

test("loadConfig rejects a missing gateway endpoint", async () => {
  const path = await configFile(
    "yaml",
    `
providers:
  devmate:
    endpoint: https://devmate.example
models: []
`,
  );
  await assert.rejects(loadConfig(path), /providers\.gateway\.endpoint/);
});

test("model limit maps to the opencode nested limit shape", async () => {
  const path = await configFile(
    "yaml",
    `
providers:
  gateway:
    endpoint: https://gateway.example
models:
  - gatewayId: model-a
    limit:
      context: 200000
      input: 180000
      output: 32000
`,
  );
  const loaded = await loadConfig(path);
  assert.deepEqual(loaded.config?.models[0].limit, {
    context: 200000,
    input: 180000,
    output: 32000,
  });
  assert.deepEqual(staticModelOverlays(loaded.config!), {
    "model-a": { limit: { context: 200000, input: 180000, output: 32000 } },
  });
});

test("loadConfig rejects a limit with unknown fields or empty body", async () => {
  const path = await configFile(
    "yaml",
    `
providers:
  gateway:
    endpoint: https://gateway.example
models:
  - gatewayId: model-a
    limit: {}
`,
  );
  await assert.rejects(loadConfig(path), /models\[0\]\.limit/);
});

test("static model API and reasoning fields map to fixed provider packages and variants", async () => {
  const path = await configFile(
    "jsonc",
    `{
  "providers": { "gateway": { "endpoint": "https://gateway.example" } },
  "models": [{
    "gatewayId": "model-a",
    "api": "openai-responses",
    "reasoning": true,
    "variants": [{ "id": "high", "reasoningEffort": "high" }]
  }]
}`,
  );
  const loaded = await loadConfig(path);
  assert.deepEqual(staticModelOverlays(loaded.config!), {
    "model-a": {
      package: "@opencode/ai/providers/openai",
      variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
    },
  });
});

test("schedule windows may be omitted when only the beyond route is needed", async () => {
  const path = await configFile(
    "yaml",
    `
providers:
  gateway:
    endpoint: https://gateway.example
  devmate:
    endpoint: https://devmate.example
models:
  - gatewayId: model-a
    schedule:
      beyond: devmate
`,
  );
  const loaded = await loadConfig(path);
  assert.deepEqual(loaded.config?.models[0].schedule?.windows, []);
  assert.equal(
    routingFromConfig(loaded.config!)?.models["model-a"].timezone,
    undefined,
  );
});
