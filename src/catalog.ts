import { Integration, Model, Provider } from "@opencode/plugin";
import type { ProviderEditor } from "@opencode/plugin/promise/provider";
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

function modelInfo(
  providerID: string,
  modelID: string,
  source: ConfigModel,
): Model.Info {
  const defaults = Model.Info.default(
    providerID as typeof Provider.ID.Type,
    modelID as typeof Model.ID.Type,
  );
  return {
    ...defaults,
    name: source.name,
    capabilities: {
      tools: source.capabilities.tools,
      input: [...source.capabilities.input],
      output: [...source.capabilities.output],
    },
    limit: { ...source.limit },
    variants:
      source.variants?.map((variant) => ({
        id: variant.id as typeof Model.VariantID.Type,
        settings: cloneValue(variant.settings) as Record<string, unknown>,
      })) ?? [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    ...(source.package === undefined ? {} : { package: source.package }),
  };
}

/** Publish the Gateway provider source for the V2 provider registry. */
export function applyGatewayProviderSnapshot(
  editor: ProviderEditor,
  snapshot: CatalogSnapshot,
  ids: CatalogProviderIDs,
): void {
  const {
    gateway: gatewayProviderID,
    gatewayPackage,
    devmate: devmateProviderID,
  } = ids;

  const models = Object.entries(snapshot.models).map(([modelID, model]) =>
    modelInfo(gatewayProviderID, modelID, model),
  );
  const providerInfo = {
    ...Provider.Info.empty(gatewayProviderID as typeof Provider.ID.Type),
    package: gatewayPackage,
    name: "ZMLLMGW",
    activation: "enabled" as const,
    integrationID:
      gatewayProviderID as unknown as typeof Integration.ID.Type,
    settings: snapshot.baseURL ? { baseURL: snapshot.baseURL } : {},
    headers: {},
    body: {},
  };

  if (editor.get(gatewayProviderID)) {
    editor.update(gatewayProviderID, (provider) => {
      delete provider.canonical;
      delete provider.compaction;
      Object.assign(provider, providerInfo);
    });
    editor.models.set(gatewayProviderID, models);
  } else {
    editor.add({ info: providerInfo, models });
  }

  // DevMate is an internal routing inventory, never a selectable provider.
  if (editor.get(devmateProviderID)) editor.remove(devmateProviderID);
}
