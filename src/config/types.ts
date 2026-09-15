export type ConfigModelApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type ConfigVariant = {
  id: string;
  reasoningEffort?: string;
};

export type ConfigScheduleWindow = {
  start: string;
  end: string;
};

export type ConfigSchedule = {
  timezone?: string;
  windows: ConfigScheduleWindow[];
  within?: "devmate" | "gateway";
  beyond: "devmate" | "gateway";
};

export type ConfigModelLimit = {
  context?: number;
  input?: number;
  output?: number;
};

export type ConfigAutoContinue = {
  prompt?: string;
  maxRounds?: number;
};

export type RawConfigModel = {
  gatewayId: string;
  devmateId?: string;
  name?: string;
  api?: ConfigModelApi;
  reasoning?: boolean;
  vision?: boolean;
  tools?: boolean;
  limit?: ConfigModelLimit;
  variants?: ConfigVariant[];
  schedule?: ConfigSchedule;
  autoContinue?: boolean;
};

export type RawConfigProvider = {
  id?: string;
  endpoint?: string;
};

export type RawConfigProviders = {
  gateway: RawConfigProvider & { endpoint: string };
  devmate?: RawConfigProvider;
  admin?: RawConfigProvider;
};

export type RawConfig = {
  providers: RawConfigProviders;
  cache: {
    ttl: string | number;
  };
  filters: {
    vendors?: string[];
    include?: string[];
    exclude?: string[];
  };
  autoContinue: ConfigAutoContinue;
  models: RawConfigModel[];
};

export type ResolvedConfigModel = RawConfigModel & {
  devmateId: string;
};

export type ResolvedConfigProvider = {
  id: string;
  endpoint?: string;
};

export type ResolvedConfigProviders = {
  gateway: ResolvedConfigProvider & { endpoint: string };
  devmate?: ResolvedConfigProvider;
  admin?: ResolvedConfigProvider;
};

export type ResolvedConfig = Omit<RawConfig, "providers" | "models"> & {
  providers: ResolvedConfigProviders;
  models: ResolvedConfigModel[];
};

/** Provider integration IDs used when a `providers.*.id` is not supplied. */
export const DEFAULT_PROVIDER_IDS = {
  gateway: "zmllmgw",
  devmate: "zmdevmate",
  admin: "zmllmadm",
} as const;
