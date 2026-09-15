import type { ModelRoutingOptions } from "./options.js";
import type { ConfigModel } from "./model-config.js";

export type ModelInventory = Readonly<Record<string, ConfigModel>>;

export type RuntimeSnapshot = {
  gateway: {
    baseURL?: string;
    nativeBaseURL?: string;
    models: ModelInventory;
  };
  devmate: {
    baseURL?: string;
    nativeBaseURL?: string;
    models: ModelInventory;
  };
  routing?: ModelRoutingOptions;
};

export function emptyRuntimeSnapshot(): RuntimeSnapshot {
  return {
    gateway: { models: {} },
    devmate: { models: {} },
  };
}
