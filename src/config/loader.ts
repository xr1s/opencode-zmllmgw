import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  parse as parseJSONC,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import { parseDocument } from "yaml";
import { parseTtlMs } from "../profile-cache.js";
import type {
  ConfigModelApi,
  ConfigModelLimit,
  ConfigSchedule,
  ConfigVariant,
  RawConfig,
  RawConfigModel,
  RawConfigProvider,
  ResolvedConfig,
} from "./types.js";
import { DEFAULT_PROVIDER_IDS } from "./types.js";

export const DEFAULT_CONFIG_DIRECTORY = join(
  process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), ".config"),
  "opencode",
  "zmllmgw",
);
export const DEFAULT_CONFIG_FILE = join(
  DEFAULT_CONFIG_DIRECTORY,
  "config.yaml",
);
export const CONFIG_ENVIRONMENT_VARIABLE = "ZMLLMGW_CONFIG";
export const DEFAULT_CACHE_TTL = "1d";

const MODEL_APIS: readonly ConfigModelApi[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];
const CONFIG_CANDIDATES = [
  "config.yaml",
  "config.yml",
  "config.json",
  "config.jsonc",
];

type RecordValue = Record<string, unknown>;

export class ConfigFileError extends Error {
  constructor(
    message: string,
    readonly filePath?: string,
  ) {
    super(message);
    this.name = "ConfigFileError";
  }
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pathLabel(path: string): string {
  return path || "<root>";
}

function invalid(filePath: string, path: string, message: string): never {
  throw new ConfigFileError(
    `${filePath}: ${pathLabel(path)}: ${message}`,
    filePath,
  );
}

function stringField(
  value: RecordValue,
  key: string,
  path: string,
  filePath: string,
): string | undefined {
  if (!(key in value)) return undefined;
  if (typeof value[key] !== "string" || !value[key])
    invalid(filePath, `${path}.${key}`, "expected a non-empty string");
  return value[key] as string;
}

function booleanField(
  value: RecordValue,
  key: string,
  path: string,
  filePath: string,
): boolean | undefined {
  if (!(key in value)) return undefined;
  if (typeof value[key] !== "boolean")
    invalid(filePath, `${path}.${key}`, "expected a boolean");
  return value[key] as boolean;
}

function positiveIntegerField(
  value: RecordValue,
  key: string,
  path: string,
  filePath: string,
): number | undefined {
  if (!(key in value)) return undefined;
  if (
    typeof value[key] !== "number" ||
    !Number.isSafeInteger(value[key]) ||
    value[key] <= 0
  ) {
    invalid(filePath, `${path}.${key}`, "expected a positive safe integer");
  }
  return value[key] as number;
}

function stringArrayField(
  value: RecordValue,
  key: string,
  path: string,
  filePath: string,
): string[] | undefined {
  if (!(key in value)) return undefined;
  if (
    !Array.isArray(value[key]) ||
    value[key].some((item) => typeof item !== "string" || !item)
  ) {
    invalid(
      filePath,
      `${path}.${key}`,
      "expected an array of non-empty strings",
    );
  }
  return [...(value[key] as string[])];
}

function endpointField(
  value: RecordValue,
  key: string,
  path: string,
  filePath: string,
): string | undefined {
  const endpoint = stringField(value, key, path, filePath);
  if (!endpoint) return undefined;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("unsupported protocol");
  } catch {
    invalid(filePath, `${path}.${key}`, "expected an HTTP(S) URL");
  }
  return endpoint;
}

function parseApi(
  value: unknown,
  path: string,
  filePath: string,
): ConfigModelApi | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !MODEL_APIS.includes(value as ConfigModelApi)
  ) {
    invalid(filePath, path, `expected one of: ${MODEL_APIS.join(", ")}`);
  }
  return value as ConfigModelApi;
}

function parseVariant(
  value: unknown,
  index: number,
  path: string,
  filePath: string,
): ConfigVariant {
  if (!isRecord(value))
    invalid(filePath, `${path}[${index}]`, "expected an object");
  const id = stringField(value, "id", `${path}[${index}]`, filePath);
  if (!id) invalid(filePath, `${path}[${index}].id`, "is required");
  const reasoningEffort = stringField(
    value,
    "reasoningEffort",
    `${path}[${index}]`,
    filePath,
  );
  return { id, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function isClockTime(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function parseSchedule(
  value: unknown,
  path: string,
  filePath: string,
): ConfigSchedule | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) invalid(filePath, path, "expected an object");
  const timezone = stringField(value, "timezone", path, filePath);
  if (timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      invalid(filePath, `${path}.timezone`, "must be a valid IANA timezone");
    }
  }
  const windowsValue = value.windows;
  if (windowsValue !== undefined && !Array.isArray(windowsValue))
    invalid(filePath, `${path}.windows`, "must be an array");
  const windows = (windowsValue ?? []).map((item, index) => {
    if (!isRecord(item))
      invalid(filePath, `${path}.windows[${index}]`, "expected an object");
    const start = stringField(
      item,
      "start",
      `${path}.windows[${index}]`,
      filePath,
    );
    const end = stringField(item, "end", `${path}.windows[${index}]`, filePath);
    if (!start || !end || !isClockTime(start) || !isClockTime(end)) {
      invalid(
        filePath,
        `${path}.windows[${index}]`,
        "start and end must use HH:mm",
      );
    }
    if (start === end)
      invalid(
        filePath,
        `${path}.windows[${index}]`,
        "start and end must differ",
      );
    return { start, end };
  });
  const within = stringField(value, "within", path, filePath);
  const beyond = stringField(value, "beyond", path, filePath);
  if (within !== undefined && within !== "devmate" && within !== "gateway")
    invalid(filePath, `${path}.within`, "must be devmate or gateway");
  if (beyond !== "devmate" && beyond !== "gateway")
    invalid(filePath, `${path}.beyond`, "must be devmate or gateway");
  if (windows.length > 0 && !within)
    invalid(
      filePath,
      `${path}.within`,
      "is required when windows are configured",
    );
  if (windows.length === 0 && within)
    invalid(
      filePath,
      `${path}.within`,
      "is not allowed when windows are empty",
    );
  return {
    ...(timezone ? { timezone } : {}),
    windows,
    ...(within ? { within: within as ConfigSchedule["within"] } : {}),
    beyond: beyond as ConfigSchedule["beyond"],
  };
}

function parseLimit(
  value: unknown,
  path: string,
  filePath: string,
): ConfigModelLimit | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) invalid(filePath, path, "expected an object");
  const context = positiveIntegerField(value, "context", path, filePath);
  const input = positiveIntegerField(value, "input", path, filePath);
  const output = positiveIntegerField(value, "output", path, filePath);
  if (context === undefined && input === undefined && output === undefined)
    invalid(filePath, path, "expected at least one of context, input, or output");
  return {
    ...(context !== undefined ? { context } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

function parseModel(
  value: unknown,
  index: number,
  filePath: string,
): RawConfigModel {
  const path = `models[${index}]`;
  if (!isRecord(value)) invalid(filePath, path, "expected an object");
  const gatewayId = stringField(value, "gatewayId", path, filePath);
  if (!gatewayId) invalid(filePath, `${path}.gatewayId`, "is required");
  const devmateId = stringField(value, "devmateId", path, filePath);
  const name = stringField(value, "name", path, filePath);
  const api = parseApi(value.api, `${path}.api`, filePath);
  const reasoning = booleanField(value, "reasoning", path, filePath);
  const vision = booleanField(value, "vision", path, filePath);
  const tools = booleanField(value, "tools", path, filePath);
  const limit = parseLimit(value.limit, `${path}.limit`, filePath);
  const variantsValue = value.variants;
  if (variantsValue !== undefined && !Array.isArray(variantsValue))
    invalid(filePath, `${path}.variants`, "expected an array");
  const variants = variantsValue?.map((item, variantIndex) =>
    parseVariant(item, variantIndex, `${path}.variants`, filePath),
  );
  const schedule = parseSchedule(value.schedule, `${path}.schedule`, filePath);
  return {
    gatewayId,
    ...(devmateId ? { devmateId } : {}),
    ...(name ? { name } : {}),
    ...(api ? { api } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(vision !== undefined ? { vision } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(limit ? { limit } : {}),
    ...(variants ? { variants } : {}),
    ...(schedule ? { schedule } : {}),
  };
}

function parseProvider(
  value: RecordValue,
  key: string,
  filePath: string,
  requiredEndpoint: boolean,
): { id?: string; endpoint?: string } {
  const providerValue = value[key];
  if (providerValue === undefined) {
    if (requiredEndpoint)
      invalid(filePath, `providers.${key}.endpoint`, "is required");
    return {};
  }
  if (!isRecord(providerValue))
    invalid(filePath, `providers.${key}`, "must be an object");
  const id = stringField(providerValue, "id", `providers.${key}`, filePath);
  const endpoint = endpointField(
    providerValue,
    "endpoint",
    `providers.${key}`,
    filePath,
  );
  if (requiredEndpoint && !endpoint)
    invalid(filePath, `providers.${key}.endpoint`, "is required");
  return { ...(id ? { id } : {}), ...(endpoint ? { endpoint } : {}) };
}

function parseValue(value: unknown, filePath: string): RawConfig {
  if (!isRecord(value))
    invalid(filePath, "", "expected the document root to be an object");
  const providersValue = value.providers;
  if (!isRecord(providersValue))
    invalid(filePath, "providers", "is required and must be an object");
  const gateway = parseProvider(providersValue, "gateway", filePath, true);
  const devmate = parseProvider(providersValue, "devmate", filePath, false);
  const admin = parseProvider(providersValue, "admin", filePath, false);

  const cacheValue = value.cache;
  if (cacheValue !== undefined && !isRecord(cacheValue))
    invalid(filePath, "cache", "must be an object");
  const ttlValue = cacheValue?.ttl;
  if (
    ttlValue !== undefined &&
    typeof ttlValue !== "string" &&
    typeof ttlValue !== "number"
  )
    invalid(filePath, "cache.ttl", "expected a duration string or number");
  if (
    ttlValue !== undefined &&
    (parseTtlMs(ttlValue) === undefined ||
      (typeof ttlValue === "number" && ttlValue < 0))
  ) {
    invalid(
      filePath,
      "cache.ttl",
      "expected non-negative milliseconds or a duration such as 30m, 24h, or 7d",
    );
  }
  const filtersValue = value.filters;
  if (filtersValue !== undefined && !isRecord(filtersValue))
    invalid(filePath, "filters", "must be an object");
  const filters = {
    ...(filtersValue
      ? {
          vendors: stringArrayField(
            filtersValue,
            "vendors",
            "filters",
            filePath,
          ),
        }
      : {}),
    ...(filtersValue
      ? {
          include: stringArrayField(
            filtersValue,
            "include",
            "filters",
            filePath,
          ),
        }
      : {}),
    ...(filtersValue
      ? {
          exclude: stringArrayField(
            filtersValue,
            "exclude",
            "filters",
            filePath,
          ),
        }
      : {}),
  };
  const modelsValue = value.models;
  if (modelsValue !== undefined && !Array.isArray(modelsValue))
    invalid(filePath, "models", "must be an array");
  const models = (modelsValue ?? []).map((item, index) =>
    parseModel(item, index, filePath),
  );
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.gatewayId))
      invalid(filePath, "models", `duplicate gatewayId "${model.gatewayId}"`);
    seen.add(model.gatewayId);
  }
  if (
    models.some(
      (model) =>
        model.schedule &&
        (model.schedule.within === "devmate" ||
          model.schedule.beyond === "devmate"),
    ) &&
    !devmate.endpoint
  ) {
    invalid(
      filePath,
      "providers.devmate.endpoint",
      "is required by a DevMate schedule",
    );
  }
  return {
    providers: {
      gateway: {
        ...(gateway.id ? { id: gateway.id } : {}),
        endpoint: gateway.endpoint ?? "",
      },
      ...(devmate.endpoint || devmate.id ? { devmate } : {}),
      ...(admin.endpoint || admin.id ? { admin } : {}),
    },
    cache: { ttl: ttlValue ?? DEFAULT_CACHE_TTL },
    filters,
    models,
  };
}

function parseJSONCValue(text: string, filePath: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJSONC(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const error = errors[0];
    throw new ConfigFileError(
      `${filePath}: JSONC parse error at offset ${error.offset}: ${printParseErrorCode(error.error)}`,
      filePath,
    );
  }
  return value;
}

function parseYAMLValue(text: string, filePath: string): unknown {
  const document = parseDocument(text, { uniqueKeys: true, version: "1.2" });
  if (document.errors.length > 0) {
    const error = document.errors[0];
    throw new ConfigFileError(
      `${filePath}: YAML parse error: ${error.message}`,
      filePath,
    );
  }
  try {
    return document.toJS({ maxAliasCount: -1 });
  } catch (error) {
    throw new ConfigFileError(
      `${filePath}: YAML value conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    );
  }
}

function expandPath(value: string): string {
  if (value === "~") return process.env.HOME || homedir();
  if (value.startsWith("~/"))
    return join(process.env.HOME || homedir(), value.slice(2));
  return value;
}

export function configuredPath(): string | undefined {
  const value = process.env[CONFIG_ENVIRONMENT_VARIABLE];
  return value ? resolve(expandPath(value)) : undefined;
}

export async function resolveConfigPath(): Promise<string | undefined> {
  const explicit = configuredPath();
  if (explicit) return explicit;
  const existing: string[] = [];
  for (const candidate of CONFIG_CANDIDATES) {
    try {
      await readFile(join(DEFAULT_CONFIG_DIRECTORY, candidate), "utf8");
      existing.push(join(DEFAULT_CONFIG_DIRECTORY, candidate));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (existing.length > 1)
    throw new ConfigFileError(
      `Multiple default configuration files found: ${existing.join(", ")}`,
    );
  return existing[0];
}

export async function loadConfig(
  filePath?: string,
): Promise<{ path?: string; config?: ResolvedConfig }> {
  const path = filePath ?? (await resolveConfigPath());
  if (!path) return {};
  const absolutePath = isAbsolute(path) ? path : resolve(path);
  let text: string;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path: absolutePath };
    throw new ConfigFileError(
      `${absolutePath}: unable to read file: ${error instanceof Error ? error.message : String(error)}`,
      absolutePath,
    );
  }
  const extension = absolutePath.toLowerCase().split(".").pop();
  if (
    extension !== "yaml" &&
    extension !== "yml" &&
    extension !== "json" &&
    extension !== "jsonc"
  ) {
    throw new ConfigFileError(
      `${absolutePath}: unsupported configuration extension`,
      absolutePath,
    );
  }
  const value =
    extension === "yaml" || extension === "yml"
      ? parseYAMLValue(text, absolutePath)
      : parseJSONCValue(text, absolutePath);
  const raw = parseValue(value, absolutePath);
  return {
    path: absolutePath,
    config: {
      ...raw,
      providers: {
        gateway: {
          id: raw.providers.gateway.id ?? DEFAULT_PROVIDER_IDS.gateway,
          endpoint: raw.providers.gateway.endpoint,
        },
        ...(raw.providers.devmate
          ? {
              devmate: {
                id: raw.providers.devmate.id ?? DEFAULT_PROVIDER_IDS.devmate,
                ...(raw.providers.devmate.endpoint
                  ? { endpoint: raw.providers.devmate.endpoint }
                  : {}),
              },
            }
          : {}),
        ...(raw.providers.admin
          ? {
              admin: {
                id: raw.providers.admin.id ?? DEFAULT_PROVIDER_IDS.admin,
                ...(raw.providers.admin.endpoint
                  ? { endpoint: raw.providers.admin.endpoint }
                  : {}),
              },
            }
          : {}),
      },
      models: raw.models.map((model) => ({
        ...model,
        devmateId: model.devmateId ?? model.gatewayId,
      })),
    },
  };
}
