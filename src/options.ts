export type ModelRoutingTimeWindow = {
  /** Start time in local time or `timezone`, inclusive, for example `18:00`. */
  start: string;
  /** End time in local time or `timezone`, exclusive, for example `21:00`. */
  end: string;
};

export type ModelRoutingEndpoint = {
  provider: "gateway" | "devmate";
  model: string;
};

export type ModelRoutingRule = {
  windows: ModelRoutingTimeWindow[];
  timezone?: string;
  within?: ModelRoutingEndpoint;
  beyond: ModelRoutingEndpoint;
};

export type ModelRoutingOptions = {
  /** DevMate endpoint; the plugin fills it from the internal provider config when omitted. */
  devmateBaseURL?: string;
  /** Same-ID models discovered in both providers and defaulted to DevMate by the plugin. */
  defaultModels?: Record<string, ModelRoutingEndpoint>;
  /** IANA timezone; omitted means the machine's local timezone. */
  models: Record<string, ModelRoutingRule>;
  timezone?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isClockTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function parseRoutingWindow(
  value: unknown,
  modelId: string,
  index: number,
): ModelRoutingTimeWindow {
  if (
    !isRecord(value) ||
    !isClockTime(value.start) ||
    !isClockTime(value.end)
  ) {
    throw new Error(
      `Invalid routing window ${index} for model "${modelId}"; expected HH:mm start and end`,
    );
  }
  if (value.start === value.end) {
    throw new Error(
      `Invalid routing window ${index} for model "${modelId}"; start and end must differ`,
    );
  }
  return { start: value.start, end: value.end };
}

function parseRoutingEndpoint(
  value: unknown,
  modelId: string,
  side: string,
): ModelRoutingEndpoint {
  if (!isRecord(value))
    throw new Error(
      `Routing rule for model "${modelId}" has an invalid ${side} endpoint`,
    );
  if (value.provider !== "gateway" && value.provider !== "devmate") {
    throw new Error(
      `Routing rule for model "${modelId}" has an invalid ${side} provider`,
    );
  }
  if (typeof value.model !== "string" || !value.model) {
    throw new Error(
      `Routing rule for model "${modelId}" has an invalid ${side} model`,
    );
  }
  return { provider: value.provider, model: value.model };
}

/** Parse the untyped `routing` value from the Gateway provider's JSON config. */
export function parseModelRoutingOptions(
  value: unknown,
): ModelRoutingOptions | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value))
    throw new Error("Invalid provider routing configuration");

  const modelsValue = value.models;
  if (!isRecord(modelsValue) || Object.keys(modelsValue).length === 0) {
    throw new Error("Provider routing requires a non-empty models object");
  }

  const models: Record<string, ModelRoutingRule> = {};
  for (const [modelId, routeValue] of Object.entries(modelsValue)) {
    if (!isRecord(routeValue))
      throw new Error(`Invalid routing rule for model "${modelId}"`);
    const windows = Array.isArray(routeValue.windows)
      ? routeValue.windows.map((window, index) =>
          parseRoutingWindow(window, modelId, index),
        )
      : [];
    if (windows.length > 0 && routeValue.within === undefined) {
      throw new Error(
        `Routing rule for model "${modelId}" requires a within endpoint when windows are configured`,
      );
    }
    if (windows.length === 0 && routeValue.within !== undefined) {
      throw new Error(
        `Routing rule for model "${modelId}" cannot define within without windows`,
      );
    }
    models[modelId] = {
      windows,
      ...(typeof routeValue.timezone === "string" && routeValue.timezone
        ? { timezone: routeValue.timezone }
        : {}),
      ...(routeValue.within !== undefined
        ? { within: parseRoutingEndpoint(routeValue.within, modelId, "within") }
        : {}),
      beyond: parseRoutingEndpoint(routeValue.beyond, modelId, "beyond"),
    };
  }

  const defaultModelsValue = value.defaultModels;
  if (defaultModelsValue !== undefined && !isRecord(defaultModelsValue)) {
    throw new Error("Provider routing has invalid defaultModels");
  }
  const defaultModels: Record<string, ModelRoutingEndpoint> = {};
  for (const [modelId, endpoint] of Object.entries(defaultModelsValue ?? {})) {
    defaultModels[modelId] = parseRoutingEndpoint(endpoint, modelId, "default");
  }

  const devmateBaseURL = value.devmateBaseURL;
  if (
    devmateBaseURL !== undefined &&
    (typeof devmateBaseURL !== "string" || !devmateBaseURL)
  ) {
    throw new Error("Provider routing has an invalid devmateBaseURL");
  }
  const timezone = value.timezone;
  if (timezone !== undefined && (typeof timezone !== "string" || !timezone)) {
    throw new Error("Provider routing has an invalid timezone");
  }

  return {
    ...(devmateBaseURL ? { devmateBaseURL } : {}),
    ...(Object.keys(defaultModels).length > 0 ? { defaultModels } : {}),
    ...(timezone ? { timezone } : {}),
    models,
  };
}
