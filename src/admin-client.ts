/**
 * Client for the LLM Gateway admin API.
 *
 * This API is the authoritative source for *which models a workspace is
 * actually approved to call* (`current_eligibility`) — the inference gateway's
 * own `GET /v1/models` only lists the global catalog (every model registered
 * with the gateway, including ones this workspace has no access to), so
 * discovery built on `/v1/models` surfaces models that fail at call time.
 *
 * The admin API authenticates with an Okta-issued id_token
 * (`Authorization: Bearer`), NOT the gateway personal API key. It is a
 * different system (the admin UI) from the inference gateway.
 *
 * Okta OIDC is proxied through this API's backend rather than hit directly:
 *   - `GET  /api/auth/okta/config`        -> Okta issuer + clientID
 *   - `POST /api/auth/okta/exchange`       -> `access_token` + long-lived `refresh_token`
 *   - `POST /api/auth/okta/refresh`        -> fresh `access_token` from a `refresh_token`
 *   - `GET  /api/auth/me`                  -> caller identity (workspace id)
 *   - `GET  /api/workspace-model-profiles/<ws>/access` -> approved models
 *
 * All per-endpoint knowledge lives here; the plugin maps the raw
 * `current_eligibility` entries into OpenCode model configs in
 * `model-mapping.ts`.
 */

export type OktaConfig = {
  clientID: string;
  enabled: boolean;
  issuer: string;
};

export type ModelProvider = {
  model_provider: string;
  deployments?: Array<Record<string, unknown>>;
};

export type ClientModelConfig = {
  client_model_config_id: number;
  model_name: string;
  display_name?: string;
  description?: string;
  vendor?: string;
  modality?: string;
  context_length?: number;
  status?: string;
  ratelimit_json?: string | null;
  metadata_json?: string | null;
  providers?: ModelProvider[];
};

export type EligibilityEntry = {
  client_model_config: ClientModelConfig;
};

export type WorkspaceProfileResponse = {
  profile?: { profile_id?: string };
  usage_budget?: unknown;
  catalog?: ClientModelConfig[] | null;
  current_eligibility: EligibilityEntry[];
  page?: number;
  page_size?: number;
  total?: number;
  page_count?: number;
};

export type WorkspaceProfile = {
  profileId?: string;
  /** Approved models, keyed off `current_eligibility` (the authoritative set). */
  eligibility: EligibilityEntry[];
};

async function adminRequest<T>(params: {
  baseURL: string;
  path: string;
  operation: string;
  method?: "GET" | "POST";
  accessToken?: string;
  body?: unknown;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  parse: (body: unknown) => T;
}): Promise<T> {
  const fetchImpl = params.fetch ?? globalThis.fetch;
  const headers = new Headers({ "user-agent": "" });
  if (params.accessToken)
    headers.set("authorization", `Bearer ${params.accessToken}`);
  if (params.body !== undefined)
    headers.set("content-type", "application/json");
  const response = await fetchImpl(
    `${params.baseURL.replace(/\/+$/, "")}${params.path}`,
    {
      method: params.method ?? "GET",
      headers,
      ...(params.body === undefined
        ? {}
        : { body: JSON.stringify(params.body) }),
      signal: params.signal,
    },
  );
  if (!response.ok) {
    throw new Error(
      `ZMLLMGW: ${params.operation} failed (${response.status} ${response.statusText})`,
    );
  }
  return params.parse((await response.json()) as unknown);
}

/** Parse the Okta OIDC config endpoint. */
export async function fetchOktaConfig(params: {
  baseURL: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<OktaConfig> {
  return adminRequest({
    ...params,
    path: "/api/auth/okta/config",
    operation: "failed to fetch Okta config",
    parse: (body) => {
      const config = body as Partial<OktaConfig>;
      if (!config.clientID || !config.issuer)
        throw new Error(
          "ZMLLMGW: unexpected /api/auth/okta/config response shape",
        );
      return config as OktaConfig;
    },
  });
}

export type TokenExchangeResult = {
  access_token: string;
  refresh_token?: string;
};

/** Exchange an authorization `code` for `access_token` + `refresh_token`. */
export async function exchangeCodeForTokens(params: {
  baseURL: string;
  code: string;
  redirectUri: string;
  nonce: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<TokenExchangeResult> {
  return adminRequest({
    ...params,
    path: "/api/auth/okta/exchange",
    operation: "token exchange",
    method: "POST",
    body: {
      code: params.code,
      redirect_uri: params.redirectUri,
      nonce: params.nonce,
    },
    parse: (value) => {
      const body = value as Partial<TokenExchangeResult>;
      if (!body.access_token)
        throw new Error("ZMLLMGW: token exchange returned no access_token");
      return {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
      };
    },
  });
}

/** Exchange a long-lived `refresh_token` for a fresh `access_token` (and possibly a new refresh token). */
export async function refreshAccessToken(params: {
  baseURL: string;
  refreshToken: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<TokenExchangeResult> {
  return adminRequest({
    ...params,
    path: "/api/auth/okta/refresh",
    operation: "token refresh",
    method: "POST",
    body: { refresh_token: params.refreshToken },
    parse: (value) => {
      const body = value as Partial<TokenExchangeResult>;
      if (!body.access_token)
        throw new Error("ZMLLMGW: token refresh returned no access_token");
      return {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
      };
    },
  });
}

export type MeResponse = {
  workspace_id?: string;
  workspace?: { workspace_id?: string };
  [key: string]: unknown;
};

/** Resolve the caller's workspace id from `GET /api/auth/me`. */
export async function fetchCurrentWorkspaceId(params: {
  baseURL: string;
  accessToken: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<string> {
  const baseURL = params.baseURL.replace(/\/+$/, "");
  const body = await adminRequest({
    ...params,
    baseURL,
    path: "/api/auth/me",
    operation: "/api/auth/me",
    accessToken: params.accessToken,
    parse: (value) => value as MeResponse,
  });
  const id = body.workspace_id || body.workspace?.workspace_id;
  if (id) return id;

  // `/api/auth/me` doesn't always include a workspace id, so fall back to the
  // user's workspace list (`GET /api/workspaces`) and take the first entry.
  const wsBody = await adminRequest({
    ...params,
    baseURL,
    path: "/api/workspaces",
    operation: "/api/workspaces",
    accessToken: params.accessToken,
    parse: (value) => value as { items?: { workspace_id?: string }[] },
  });
  const wsId = wsBody.items?.[0]?.workspace_id;
  if (!wsId)
    throw new Error("ZMLLMGW: /api/workspaces returned no workspace_id");
  return wsId;
}

/**
 * Fetch the workspace model profile (approved models). `current_eligibility`
 * is returned non-paginated and is the authoritative set; the `catalog` field
 * may be null/empty depending on pagination and is NOT used as the source of
 * truth.
 */
export async function fetchWorkspaceProfile(params: {
  baseURL: string;
  accessToken: string;
  workspaceId: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<WorkspaceProfile> {
  return adminRequest({
    ...params,
    path: `/api/workspace-model-profiles/${encodeURIComponent(params.workspaceId)}/access?page=1&page_size=500`,
    operation: "workspace profile fetch",
    accessToken: params.accessToken,
    parse: (value) => {
      const body = value as WorkspaceProfileResponse;
      if (!Array.isArray(body.current_eligibility)) {
        throw new Error("ZMLLMGW: unexpected workspace profile response shape");
      }
      return {
        profileId: body.profile?.profile_id,
        eligibility: body.current_eligibility,
      };
    },
  });
}
