import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Zmllmgw } from "../src/plugin.js";

const GATEWAY_ID = "zmllmgw";
const ADMIN_ID = "zmllmadm";
const DEVMATE_ID = "zmdevmate";
const BASE_URL = "https://gateway.example/v1";
const DEVMATE_URL = "https://devmate.example/api/v1/llm-proxy/v1";

type TestModel = {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  variants: unknown[];
  limit: { context: number; output: number };
  package?: string;
  [key: string]: unknown;
};

type TestProvider = {
  id: string;
  name?: string;
  package?: string;
  settings?: Record<string, unknown>;
};

type TestCredential =
  | { type: "key"; key: string }
  | {
      type: "oauth";
      access: string;
      refresh: string;
      expires: number;
      methodID: string;
    };

function model(
  providerID: string,
  id: string,
  packageName?: string,
): TestModel {
  return {
    id,
    modelID: id,
    providerID,
    name: id,
    ...(packageName ? { package: packageName } : {}),
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    limit: { context: 128000, output: 4096 },
  };
}

async function configFile(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zmllmgw-plugin-"));
  const path = join(directory, "config.yaml");
  await writeFile(path, content);
  return path;
}

let configLock = Promise.resolve();

async function withConfig(
  path: string,
  callback: () => Promise<void>,
): Promise<void> {
  const previousLock = configLock;
  let release!: () => void;
  configLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previousLock;

  // Point the plugin's data home at a throwaway temp dir so the tests exercise
  // the real profile-cache write/read path without touching the user's real
  // `~/.local/share/opencode` directory.
  const dataDir = await mkdtemp(join(tmpdir(), "zmllmgw-data-"));
  const previousConfig = process.env.ZMLLMGW_CONFIG;
  const previousData = process.env.XDG_DATA_HOME;
  process.env.ZMLLMGW_CONFIG = path;
  process.env.XDG_DATA_HOME = dataDir;
  try {
    await callback();
  } finally {
    if (previousConfig === undefined) delete process.env.ZMLLMGW_CONFIG;
    else process.env.ZMLLMGW_CONFIG = previousConfig;
    if (previousData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousData;
    release();
  }
}

function testContext(input: {
  provider?: TestProvider;
  models?: TestModel[];
  credentials?: Record<string, TestCredential>;
}) {
  const provider = input.provider ?? {
    id: GATEWAY_ID,
    name: "Gateway",
    package: "opencode-zmllmgw",
  };
  const record = {
    provider,
    models: new Map((input.models ?? []).map((item) => [item.id, item])),
  };
  const records = new Map([[provider.id, record]]);
  const credentials = input.credentials ?? {};
  const hooks: Record<string, (event: any) => Promise<void> | void> = {};
  const integrations: Record<string, { id: string; name: string }> = {};
  const methods: Array<{ integrationID: string; method: { type: string } }> =
    [];
  const commands: Array<{ name: string; execute: () => Promise<void> }> = [];
  const providerTransforms: Array<(editor: any) => void> = [];
  const integrationTransforms: Array<(editor: any) => void> = [];
  let providerReloads = 0;

  const providerEditor = {
    get: (id: string) => records.get(id),
    list: () => [...records.values()],
    add: (input: { info: TestProvider; models: TestModel[] }) => {
      records.set(input.info.id, {
        provider: input.info,
        models: new Map(input.models.map((item) => [item.id, item])),
      });
    },
    update: (id: string, callback: (value: TestProvider) => void) => {
      const item = records.get(id);
      if (!item) throw new Error(`missing provider ${id}`);
      callback(item.provider);
    },
    remove: (id: string) => records.delete(id),
    models: {
      set: (providerID: string, models: TestModel[]) => {
        const item = records.get(providerID);
        if (!item) throw new Error(`missing provider ${providerID}`);
        item.models = new Map(models.map((value) => [value.id, value]));
      },
    },
  };

  const context = {
    options: {},
    provider: {
      list: async () => ({
        data: [...records.values()].map((item) => item.provider),
      }),
      reload: async () => {
        providerReloads += 1;
        for (const callback of providerTransforms) callback(providerEditor);
      },
      transform: async (callback: (editor: any) => void) => {
        providerTransforms.push(callback);
        callback(providerEditor);
        return { dispose: async () => {} };
      },
    },
    integration: {
      transform: async (callback: (editor: any) => void) => {
        integrationTransforms.push(callback);
        callback({
          get: (id: string) => integrations[id],
          remove: (id: string) => {
            delete integrations[id];
          },
          update: (
            id: string,
            update: (value: { id: string; name: string }) => void,
          ) => {
            integrations[id] ??= { id, name: id };
            update(integrations[id]);
          },
          method: {
            update: (registration: {
              integrationID: string;
              method: { type: string };
            }) => methods.push(registration),
          },
        });
        return { dispose: async () => {} };
      },
      reload: async () => {
        for (const callback of integrationTransforms)
          callback({
            get: (id: string) => integrations[id],
            remove: (id: string) => {
              delete integrations[id];
            },
            update: (
              id: string,
              update: (value: { id: string; name: string }) => void,
            ) => {
              integrations[id] ??= { id, name: id };
              update(integrations[id]);
            },
            method: {
              update: (registration: {
                integrationID: string;
                method: { type: string };
              }) => methods.push(registration),
            },
          });
      },
      connection: {
        active: async (id: string) =>
          credentials[id] ? { id: `credential-${id}` } : undefined,
        resolve: async (connection: { id: string }) =>
          credentials[connection.id.replace("credential-", "")],
      },
    },
    command: {
      transform: async (
        callback: (editor: {
          add: (command: {
            name: string;
            execute: () => Promise<void>;
          }) => void;
        }) => void,
      ) => {
        callback({ add: (command) => commands.push(command) });
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (
        name: string,
        callback: (event: any) => Promise<void> | void,
      ) => {
        hooks[name] = callback;
        return { dispose: async () => {} };
      },
    },
  };

  return {
    context,
    provider,
    record,
    hooks,
    integrations,
    methods,
    commands,
    providerReloads: () => providerReloads,
  };
}

test("V2 setup uses the independent config and only protocol request fields", async () => {
  const path = await configFile(`
providers:
  gateway:
    endpoint: https://gateway.example
models:
  - gatewayId: chat-model
`);
  const fixture = testContext({
    provider: {
      id: GATEWAY_ID,
      name: "Gateway",
      package: "opencode-zmllmgw",
      settings: { baseURL: "https://old.example/v1" },
    },
    models: [
      {
        ...model(GATEWAY_ID, "chat-model"),
        package: "old-provider-package",
        modelID: "old-backend-id",
        settings: { baseURL: "https://old.example/v1", old: true },
        headers: { "x-old-header": "remove-me" },
        body: { old: true },
        enabled: false,
      },
    ],
    credentials: { [GATEWAY_ID]: { type: "key", key: "gateway-key" } },
  });

  await withConfig(path, async () => {
    await Zmllmgw.setup(fixture.context as never);
  });

  assert.deepEqual(fixture.provider.settings, { baseURL: BASE_URL });
  assert.deepEqual([...fixture.record.models.keys()], ["chat-model"]);
  const projected = fixture.record.models.get("chat-model")!;
  assert.equal(projected.modelID, "chat-model");
  assert.equal(projected.enabled, true);
  assert.deepEqual(projected.variants, []);
  assert.equal(projected.settings, undefined);
  assert.equal(projected.headers, undefined);
  assert.equal(projected.body, undefined);
  assert.deepEqual(
    fixture.methods.map((item) => [item.integrationID, item.method.type]),
    [
      [DEVMATE_ID, "key"],
      [GATEWAY_ID, "key"],
    ],
  );
  assert.ok(fixture.commands.some((item) => item.name === "reload-zmllmgw"));

  const event = {
    sessionID: "ses_test",
    agent: "build",
    kind: "primary",
    model: { providerID: GATEWAY_ID, id: "chat-model" },
    request: new Request(`${BASE_URL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "chat-model", messages: [] }),
    }),
  };
  await fixture.hooks["http.request"](event);
  assert.equal(event.request.headers.get("x-api-key"), "gateway-key");
  assert.equal(event.request.headers.get("llm-settings"), null);
  assert.deepEqual(await event.request.json(), {
    model: "chat-model",
    messages: [],
    task_id: "ses_test",
  });
});

test("workspace discovery projects models from the admin profile", async () => {
  const adminURL = `https://admin-discovery-${Date.now()}-${Math.random().toString(16).slice(2)}.example`;
  const path = await configFile(`
providers:
  gateway:
    endpoint: https://gateway.example
  admin:
    endpoint: ${adminURL}
models: []
`);
  const fixture = testContext({
    credentials: {
      [ADMIN_ID]: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 3_600_000,
        methodID: "oauth",
      },
    },
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/auth/me"))
      return new Response(JSON.stringify({ email: "user@example.com" }), {
        status: 200,
      });
    if (url.endsWith("/api/workspaces"))
      return new Response(
        JSON.stringify({ items: [{ workspace_id: "workspace-discovery" }] }),
        { status: 200 },
      );
    if (
      url.includes("/api/workspace-model-profiles/workspace-discovery/access")
    ) {
      return new Response(
        JSON.stringify({
          current_eligibility: [
            {
              client_model_config: {
                client_model_config_id: 1,
                model_name: "gpt-5.6-luna",
                vendor: "openai",
                context_length: 1_050_000,
                modality: "file+image+text->text",
                providers: [{ model_provider: "openai/gpt-5.6-luna" }],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  try {
    await withConfig(path, async () => {
      await Zmllmgw.setup(fixture.context as never);
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  const discovered = fixture.record.models.get("gpt-5.6-luna");
  assert.ok(discovered);
  assert.deepEqual(fixture.integrations, {
    [ADMIN_ID]: { id: ADMIN_ID, name: "ZMLLMADM" },
    [DEVMATE_ID]: { id: DEVMATE_ID, name: "ZMDEVMATE" },
    [GATEWAY_ID]: { id: GATEWAY_ID, name: "ZMLLMGW" },
  });
  assert.equal(discovered.limit.context, 1_050_000);
  assert.deepEqual(discovered.capabilities.input, ["text", "image"]);
});

test("remote discovery failure preserves the previously published snapshot", async () => {
  const adminURL = `https://admin-preserve-${Date.now()}-${Math.random().toString(16).slice(2)}.example`;
  const path = await configFile(`
providers:
  gateway:
    endpoint: https://gateway.example
  admin:
    endpoint: ${adminURL}
models:
  - gatewayId: static-model
`);
  const fixture = testContext({
    credentials: {
      [ADMIN_ID]: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 3_600_000,
        methodID: "oauth",
      },
    },
  });
  const previousFetch = globalThis.fetch;
  let failing = false;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (failing)
      return new Response("unavailable", {
        status: 503,
        statusText: "Unavailable",
      });
    if (url.endsWith("/api/auth/me"))
      return new Response(
        JSON.stringify({ workspace_id: "workspace-preserve" }),
        { status: 200 },
      );
    if (
      url.includes("/api/workspace-model-profiles/workspace-preserve/access")
    ) {
      return new Response(
        JSON.stringify({
          current_eligibility: [
            {
              client_model_config: {
                client_model_config_id: 2,
                model_name: "dynamic-model",
                vendor: "openai",
                providers: [{ model_provider: "openai/dynamic-model" }],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  try {
    await withConfig(path, async () => {
      await Zmllmgw.setup(fixture.context as never);
      assert.ok(fixture.record.models.has("dynamic-model"));
      failing = true;
      const reload = fixture.commands.find(
        (item) => item.name === "reload-zmllmgw",
      )!;
      await reload.execute();
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.ok(fixture.record.models.has("dynamic-model"));
  assert.ok(fixture.record.models.has("static-model"));
});

test("V2 keeps the plugin active with an empty provider source when config is missing", async () => {
  const fixture = testContext({
    provider: {
      id: GATEWAY_ID,
      name: "Gateway",
      package: "opencode-zmllmgw",
      settings: { baseURL: BASE_URL },
    },
    models: [model(GATEWAY_ID, "old-model")],
  });
  const missingPath = join(
    await mkdtemp(join(tmpdir(), "zmllmgw-missing-")),
    "config.yaml",
  );

  await withConfig(missingPath, async () => {
    await Zmllmgw.setup(fixture.context as never);
  });

  assert.deepEqual(fixture.provider.settings, {});
  assert.equal(fixture.record.models.size, 0);
  assert.equal(fixture.commands.length, 1);
  assert.equal(fixture.hooks["http.request"] !== undefined, true);
});

test("native Google requests use the same independent-config pipeline", async () => {
  const path = await configFile(`
providers:
  gateway:
    endpoint: https://gateway.example
models:
  - gatewayId: gemini-2.5-pro
    api: google-generative-ai
`);
  const fixture = testContext({
    credentials: { [GATEWAY_ID]: { type: "key", key: "gateway-key" } },
  });

  await withConfig(path, async () => {
    await Zmllmgw.setup(fixture.context as never);
  });

  const event = {
    sessionID: "ses_google",
    agent: "build",
    kind: "primary",
    model: { providerID: GATEWAY_ID, id: "gemini-2.5-pro" },
    request: new Request(`${BASE_URL}/models/gemini-2.5-pro:generateContent`, {
      method: "POST",
      body: "{}",
    }),
  };
  await fixture.hooks["http.request"](event);
  assert.equal(
    event.request.url,
    `${BASE_URL}/v1beta/models/gemini-2.5-pro:generateContent`,
  );
  assert.equal(event.request.headers.get("x-api-key"), "gateway-key");
  assert.deepEqual(await event.request.json(), { task_id: "ses_google" });
});

test("native models keep their package when routed to DevMate", async () => {
  const path = await configFile(`
providers:
  gateway:
    endpoint: https://gateway.example
  devmate:
    endpoint: https://devmate.example/api/v1/llm-proxy
models:
  - gatewayId: gpt-5.6-luna
    api: openai-responses
    schedule:
      beyond: devmate
`);
  const fixture = testContext({
    credentials: {
      [GATEWAY_ID]: { type: "key", key: "gateway-key" },
      [DEVMATE_ID]: { type: "key", key: "devmate-key" },
    },
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200 });
  try {
    await withConfig(path, async () => {
      await Zmllmgw.setup(fixture.context as never);
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  const event = {
    sessionID: "ses_native_route",
    agent: "build",
    kind: "primary",
    model: { providerID: GATEWAY_ID, id: "gpt-5.6-luna" },
    request: new Request(`${BASE_URL}/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-luna", input: [] }),
    }),
  };
  await fixture.hooks["http.request"](event);
  assert.equal(event.request.url, `${DEVMATE_URL}/responses`);
  assert.equal(
    event.request.headers.get("authorization"),
    "Bearer devmate-key",
  );
  assert.deepEqual(await event.request.json(), {
    model: "gpt-5.6-luna",
    input: [],
    task_id: "ses_native_route",
  });
});

test("V2 HTTP response hook strips retry delays", async () => {
  const path = await configFile(`
providers:
  gateway:
    endpoint: https://gateway.example
`);
  const fixture = testContext({});
  await withConfig(path, async () => {
    await Zmllmgw.setup(fixture.context as never);
  });
  const event = {
    sessionID: "ses_rate",
    agent: "build",
    kind: "primary",
    model: { providerID: GATEWAY_ID, id: "chat-model" },
    request: new Request(`${BASE_URL}/chat/completions`),
    response: new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "60" },
    }),
  };
  await fixture.hooks["http.response"](event);
  assert.equal(event.response.headers.get("retry-after"), null);
});
