import { fetchDevMateModels, toDevMateConfigModels } from "./devmate-models.js";
import { eligibilityToConfigModels } from "./model-mapping.js";
import {
  fetchCurrentWorkspaceId,
  fetchWorkspaceProfile,
} from "./admin-client.js";
import {
  isCacheStale,
  parseTtlMs,
  readProfileCache,
  writeProfileCache,
  type ProfileCache,
} from "./profile-cache.js";
import type { ConfigModel } from "./model-config.js";

export type ModelDiscoveryOptions = {
  cacheTtl?: string | number;
  vendors?: readonly string[];
  include?: readonly string[];
  exclude?: readonly string[];
  toolCall?: boolean;
};

export type DiscoveryLog = (entry: {
  service: string;
  level: "warn" | "error";
  message: string;
}) => Promise<void>;

export const DEFAULT_CACHE_TTL_MS = 86_400_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Return a new map with an optional exact-id exclusion applied. */
export function filterDiscoveredModels(
  models: Record<string, ConfigModel>,
  exclude: readonly string[] = [],
): Record<string, ConfigModel> {
  if (exclude.length === 0) return { ...models };
  const excluded = new Set(exclude);
  return Object.fromEntries(
    Object.entries(models).filter(([id]) => !excluded.has(id)),
  );
}

export type WorkspaceDiscoveryResult = {
  models: Record<string, ConfigModel>;
  cache: ProfileCache;
};

/**
 * Discover the current workspace's approved Gateway models.
 *
 * A stale-cache refresh failure is deliberately thrown instead of silently
 * returning stale data. The caller can then keep its last complete runtime
 * snapshot, or publish static configuration on the first load.
 */
export async function discoverFromWorkspaceProfile(ctx: {
  discovery: ModelDiscoveryOptions;
  adminBaseURL: string;
  accessToken: string;
  force?: boolean;
}): Promise<WorkspaceDiscoveryResult> {
  const adminBaseURL = ctx.adminBaseURL.replace(/\/+$/, "");
  const ttlMs = parseTtlMs(ctx.discovery.cacheTtl) ?? DEFAULT_CACHE_TTL_MS;
  const signal = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  const workspaceId = await fetchCurrentWorkspaceId({
    baseURL: adminBaseURL,
    accessToken: ctx.accessToken,
    signal,
  });
  const cacheKey = { adminBaseURL, workspaceId };
  let cache = await readProfileCache(cacheKey);

  if (!ctx.force && cache && !isCacheStale(cache, ttlMs)) {
    return {
      cache,
      models: filterDiscoveredModels(
        eligibilityToConfigModels(cache.eligibility, {
          vendors: ctx.discovery.vendors,
          include: ctx.discovery.include,
        }),
        ctx.discovery.exclude,
      ),
    };
  }

  try {
    const profile = await fetchWorkspaceProfile({
      baseURL: adminBaseURL,
      accessToken: ctx.accessToken,
      workspaceId,
      signal,
    });
    cache = {
      fetchedAt: new Date().toISOString(),
      workspaceId,
      adminBaseURL,
      eligibility: profile.eligibility,
    };
    await writeProfileCache(cacheKey, cache);
  } catch (error) {
    throw new Error(
      `workspace-profile discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    cache,
    models: filterDiscoveredModels(
      eligibilityToConfigModels(cache.eligibility, {
        vendors: ctx.discovery.vendors,
        include: ctx.discovery.include,
      }),
      ctx.discovery.exclude,
    ),
  };
}

export async function discoverFromDevMate(ctx: {
  discovery: ModelDiscoveryOptions;
  baseURL: string;
  apiKey: string;
}): Promise<Record<string, ConfigModel>> {
  try {
    const models = await fetchDevMateModels({
      baseURL: ctx.baseURL,
      apiKey: ctx.apiKey,
    });
    return filterDiscoveredModels(
      toDevMateConfigModels(models, { toolCall: ctx.discovery.toolCall }),
      ctx.discovery.exclude,
    );
  } catch (error) {
    throw new Error(
      `DevMate discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
