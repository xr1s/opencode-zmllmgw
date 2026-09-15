import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  addSharedModelDefaults,
  createRoutingClock,
  isWithinRoutingWindow,
  mergeRoutedModels,
  replaceRequestBaseURL,
  routeForModel,
  targetForModel,
  routeModelRequest,
} from "../src/model-routing.js";
import {
  parseModelRoutingOptions,
  type ModelRoutingOptions,
} from "../src/options.js";
import {
  findNativeAdapterByPackage,
  GOOGLE_NATIVE_PACKAGE,
} from "../src/native-adapters.js";

const gatewayBaseURL = "https://gateway.example/v1";
const devmateBaseURL = "https://devmate.example/api/v1/llm-proxy/v1";

function routing(
  overrides: Partial<ModelRoutingOptions> = {},
): ModelRoutingOptions {
  return {
    timezone: "UTC",
    models: {
      shared_model: {
        windows: [{ start: "18:00", end: "21:00" }],
        within: { provider: "devmate", model: "shared_model" },
        beyond: { provider: "gateway", model: "shared_model" },
      },
    },
    devmateBaseURL,
    ...overrides,
  };
}

test("parseModelRoutingOptions validates model windows and targets", () => {
  assert.deepEqual(
    parseModelRoutingOptions({
      timezone: "UTC",
      models: {
        shared_model: {
          windows: [{ start: "18:00", end: "21:00" }],
          within: { provider: "devmate", model: "shared_model" },
          beyond: { provider: "gateway", model: "shared_model" },
        },
      },
    }),
    {
      timezone: "UTC",
      models: {
        shared_model: {
          windows: [{ start: "18:00", end: "21:00" }],
          within: { provider: "devmate", model: "shared_model" },
          beyond: { provider: "gateway", model: "shared_model" },
        },
      },
    },
  );
  assert.throws(
    () =>
      parseModelRoutingOptions({
        models: {
          shared_model: {
            windows: [{ start: "18:00", end: "18:00" }],
            within: { provider: "devmate", model: "shared_model" },
            beyond: { provider: "gateway", model: "shared_model" },
          },
        },
      }),
    /start and end must differ/,
  );
});

test("routing windows are start-inclusive and end-exclusive", () => {
  const clock = createRoutingClock("UTC");
  const window = { start: "18:00", end: "21:00" };

  assert.equal(
    isWithinRoutingWindow(new Date("2026-09-11T18:00:00Z"), window, clock),
    true,
  );
  assert.equal(
    isWithinRoutingWindow(new Date("2026-09-11T20:59:00Z"), window, clock),
    true,
  );
  assert.equal(
    isWithinRoutingWindow(new Date("2026-09-11T21:00:00Z"), window, clock),
    false,
  );
  assert.equal(
    targetForModel("shared_model", routing(), new Date("2026-09-11T19:00:00Z")),
    "devmate",
  );
  assert.equal(
    targetForModel("shared_model", routing(), new Date("2026-09-11T21:00:00Z")),
    "gateway",
  );
  assert.equal(
    targetForModel("unconfigured", routing(), new Date("2026-09-11T19:00:00Z")),
    "gateway",
  );
});

test("shared model defaults can route to DevMate", () => {
  const configured = routing({
    models: {},
    defaultModels: {
      shared_model: { provider: "devmate", model: "shared_model" },
    },
  });

  assert.deepEqual(
    routeForModel("shared_model", configured, new Date("2026-09-11T19:00:00Z")),
    {
      provider: "devmate",
      model: "shared_model",
    },
  );
});

test("shared discovered model ids default to DevMate", () => {
  const parsed = addSharedModelDefaults(
    {
      models: {
        shared_model: { name: "Gateway" },
        gateway_only: { name: "Gateway only" },
      },
    },
    { models: { shared_model: { name: "DevMate" } } },
    routing({ models: {} }),
  );

  assert.deepEqual(parsed.defaultModels, {
    shared_model: { provider: "devmate", model: "shared_model" },
  });
});

test("DevMate credential failure falls back to the configured Gateway endpoint", async () => {
  const configured = routing({
    models: {
      missing: {
        windows: [],
        beyond: { provider: "devmate", model: "missing-devmate" },
      },
    },
  });
  const result = await routeModelRequest({
    request: new Request(`${gatewayBaseURL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "missing", messages: [] }),
    }),
    modelID: "missing",
    routing: configured,
    sourceBaseURL: gatewayBaseURL,
    gatewayBaseURL,
    devmateBaseURL,
    sessionID: "ses_fallback",
    gatewayApiKey: "gateway-key",
    gatewayIntegrationID: "zmllmgw",
    devmateIntegrationID: "zmdevmate",
    readApiKey: async () => undefined,
    now: () => new Date("2026-09-11T19:00:00Z"),
  });
  assert.equal(result.target, "gateway");
  assert.deepEqual(await result.request.json(), {
    model: "missing",
    messages: [],
    task_id: "ses_fallback",
  });
});

test("native Google routing changes the URL model ID without adding a compatible body model", async () => {
  const configured = parseModelRoutingOptions({
    models: {
      gateway_model: {
        windows: [],
        beyond: { provider: "devmate", model: "devmate_model" },
      },
    },
  })!;
  const result = await routeModelRequest({
    request: new Request(
      `${gatewayBaseURL}/models/gateway_model:generateContent`,
      {
        method: "POST",
        body: JSON.stringify({ contents: [] }),
      },
    ),
    modelID: "gateway_model",
    routing: { ...configured, devmateBaseURL },
    sourceBaseURL: gatewayBaseURL,
    gatewayBaseURL,
    gatewayNativeBaseURL: "https://gateway.example/v1",
    devmateBaseURL,
    devmateNativeBaseURL: "https://devmate.example/api/v1/llm-proxy/v1",
    sessionID: "ses_google_alias",
    gatewayApiKey: "gateway-key",
    gatewayIntegrationID: "zmllmgw",
    devmateIntegrationID: "zmdevmate",
    readApiKey: async () => "devmate-key",
    adapter: findNativeAdapterByPackage(GOOGLE_NATIVE_PACKAGE),
  });

  assert.equal(result.target, "devmate");
  assert.equal(
    result.request.url,
    "https://devmate.example/api/v1/llm-proxy/v1/v1beta/models/devmate_model:generateContent",
  );
  assert.deepEqual(await result.request.json(), {
    contents: [],
    task_id: "ses_google_alias",
  });
});

test("empty routing windows use only the beyond endpoint", () => {
  const parsed = parseModelRoutingOptions({
    models: {
      devmate_only: {
        windows: [],
        beyond: { provider: "devmate", model: "devmate_only" },
      },
    },
  });

  assert.deepEqual(
    routeForModel("devmate_only", parsed!, new Date("2026-09-11T19:00:00Z")),
    {
      provider: "devmate",
      model: "devmate_only",
    },
  );
});

test("routing endpoints can map different backend model ids", () => {
  const configured = routing({
    models: {
      shared_model: {
        windows: [{ start: "18:00", end: "21:00" }],
        within: { provider: "devmate", model: "shared_model_dev_mate" },
        beyond: { provider: "gateway", model: "shared_model" },
      },
    },
  });

  assert.deepEqual(
    routeForModel("shared_model", configured, new Date("2026-09-11T19:00:00Z")),
    {
      provider: "devmate",
      model: "shared_model_dev_mate",
    },
  );
  assert.deepEqual(
    routeForModel("shared_model", configured, new Date("2026-09-11T21:00:00Z")),
    {
      provider: "gateway",
      model: "shared_model",
    },
  );
});

test("routing supports windows that cross midnight", () => {
  const clock = createRoutingClock("UTC");
  const window = { start: "22:00", end: "02:00" };

  assert.equal(
    isWithinRoutingWindow(new Date("2026-09-11T23:00:00Z"), window, clock),
    true,
  );
  assert.equal(
    isWithinRoutingWindow(new Date("2026-09-12T01:59:00Z"), window, clock),
    true,
  );
  assert.equal(
    isWithinRoutingWindow(new Date("2026-09-12T02:00:00Z"), window, clock),
    false,
  );
  assert.equal(
    isWithinRoutingWindow(new Date("2026-09-12T12:00:00Z"), window, clock),
    false,
  );
});

test("replaceRequestBaseURL keeps the API path relative to each backend", () => {
  assert.equal(
    replaceRequestBaseURL(
      `${gatewayBaseURL}/chat/completions?stream=true`,
      gatewayBaseURL,
      devmateBaseURL,
    ),
    `${devmateBaseURL}/chat/completions?stream=true`,
  );
});

test("mergeRoutedModels keeps the Gateway package for routed models", () => {
  const gateway: { models: Record<string, Record<string, unknown>> } = {
    models: {
      shared_model: {
        name: "Gateway name",
        package: "@opencode/ai/providers/anthropic",
      },
    },
  };
  const devmate: { models: Record<string, Record<string, unknown>> } = {
    models: {
      shared_model: { name: "DevMate name" },
      devmate_only: { name: "DevMate only" },
      devmate_alias: { name: "DevMate alias" },
    },
  };

  const merged = mergeRoutedModels(gateway, devmate, {
    models: {
      shared_model: {
        windows: [{ start: "18:00", end: "21:00" }],
        within: { provider: "devmate", model: "shared_model" },
        beyond: { provider: "gateway", model: "shared_model" },
      },
      devmate_only: {
        windows: [{ start: "18:00", end: "21:00" }],
        within: { provider: "devmate", model: "devmate_only" },
        beyond: { provider: "gateway", model: "devmate_only" },
      },
      aliased_model: {
        windows: [{ start: "18:00", end: "21:00" }],
        within: { provider: "devmate", model: "devmate_alias" },
        beyond: { provider: "gateway", model: "aliased_model" },
      },
    },
  });

  assert.equal(merged.shared_model.name, "Gateway name");
  assert.equal(merged.shared_model.package, "@opencode/ai/providers/anthropic");
  assert.deepEqual(merged.devmate_only, { name: "DevMate only" });
  assert.deepEqual(merged.aliased_model, { name: "DevMate alias" });
});
