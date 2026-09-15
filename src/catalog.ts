import type { CatalogEditor } from "@opencode/plugin/promise/catalog";
import type { ConfigModel } from "./model-config.js";

export type CatalogSnapshot = {
  baseURL?: string;
  models: Readonly<Record<string, ConfigModel>>;
};

export type CatalogProviderIDs = {
  gateway: string;
  gatewayPackage: string;
  devmate: string;
};

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)]),
    );
  }
  return value;
}

function applyModel(
  target: ReturnType<CatalogEditor["model"]["get"]>,
  modelID: string,
  source: ConfigModel,
): void {
  if (!target)
    throw new Error(`OpenCode catalog could not create model "${modelID}"`);

  // The bootstrap/config-provider may have left an older model overlay here.
  // The independent snapshot is the only business source, so clear optional
  // provider/model overlays before applying the canonical model shape.
  for (const key of [
    "canonical",
    "family",
    "compatibility",
    "compaction",
    "websocket",
    "settings",
    "headers",
    "body",
  ] as const) {
    delete target[key];
  }

  target.modelID = modelID as unknown as typeof target.modelID;
  target.name = source.name;
  target.capabilities = {
    tools: source.capabilities.tools,
    input: [...source.capabilities.input],
    output: [...source.capabilities.output],
  };
  target.limit = { ...source.limit };
  target.variants =
    source.variants?.map((variant) => ({
      id: variant.id as unknown as (typeof target.variants)[number]["id"],
      settings: cloneValue(variant.settings) as Record<string, unknown>,
    })) ?? [];
  target.time = { released: 0 };
  target.cost = [];
  target.status = "active";
  target.enabled = true;

  if (source.package === undefined) delete target.package;
  else target.package = source.package;
}

/** Project the immutable Gateway snapshot onto the V2 catalog draft. */
export function applyGatewayCatalogSnapshot(
  catalog: CatalogEditor,
  snapshot: CatalogSnapshot,
  ids: CatalogProviderIDs,
): void {
  const {
    gateway: gatewayProviderID,
    gatewayPackage,
    devmate: devmateProviderID,
  } = ids;

  catalog.provider.update(gatewayProviderID, (provider) => {
    // The user plugin is activated before OpenCode's config-provider plugin.
    // Establish the fixed provider boundary here instead of depending on that
    // later transform having run already.
    provider.package = gatewayPackage;
    provider.name = "ZMLLMGW";
    provider.activation = "enabled";
    provider.integrationID =
      gatewayProviderID as unknown as typeof provider.integrationID;
    delete provider.canonical;
    delete provider.compaction;
    delete provider.websocket;
    provider.settings = snapshot.baseURL ? { baseURL: snapshot.baseURL } : {};
    provider.headers = {};
    provider.body = {};
  });

  const record = catalog.provider.get(gatewayProviderID);
  if (!record)
    throw new Error(
      `OpenCode catalog could not create provider "${gatewayProviderID}"`,
    );

  for (const modelID of record.models.keys()) {
    if (!snapshot.models[modelID])
      catalog.model.remove(gatewayProviderID, modelID);
  }
  for (const [modelID, model] of Object.entries(snapshot.models)) {
    catalog.model.update(gatewayProviderID, modelID, (target) => {
      applyModel(target, modelID, model);
    });
  }

  // DevMate is an internal routing inventory, never a selectable provider.
  if (catalog.provider.get(devmateProviderID))
    catalog.provider.remove(devmateProviderID);
}
