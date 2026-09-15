/**
 * Configurable on-disk cache for the workspace model profile.
 *
 * Model availability changes rarely, so discovery only needs to hit the
 * admin API when the cached result has aged past the TTL. The cache stores
 * the raw `current_eligibility` list plus the timestamp it was fetched at;
 * the plugin maps it into OpenCode model configs on read.
 *
 * The cache lives in the opencode data dir, one directory per workspace, and
 * is overwritten in place so only the latest fetch is kept on disk:
 * `~/.local/share/opencode/zmllmgw-profiles/<workspaceId>/profile.json`.
 */

import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import type { EligibilityEntry } from "./admin-client.js";
import { opencodeDataPath } from "./opencode-data.js";

export type ProfileCache = {
  fetchedAt: string;
  workspaceId: string;
  adminBaseURL: string;
  eligibility: EligibilityEntry[];
};

export type ProfileCacheKey = {
  adminBaseURL: string;
  workspaceId: string;
};

/**
 * Coerce a value into a safe single directory segment. The admin `/api/workspaces`
 * `workspace_id` is expected to be URL-safe, but we still guard against path
 * separators, dot-dot traversal, and empty/leading-dot values so the workspace
 * id can be used directly as a directory name (no hashing needed).
 */
function safeSegment(value: string): string {
  const segment = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .replace(/^-+/, "")
    .slice(0, 80);
  if (!segment) throw new Error(`cannot derive a safe segment from ${JSON.stringify(value)}`);
  return segment;
}

/** Absolute path to the profile cache file (fixed name, one per workspace). */
export function profileCachePath(key: ProfileCacheKey): string {
  return join(
    opencodeDataPath("zmllmgw-profiles"),
    safeSegment(key.workspaceId),
    "profile.json",
  );
}

/**
 * Parse a TTL duration into milliseconds. Supports:
 *   - plain number + optional `ms` suffix (`3000`, `3000ms`)
 *   - `s` / `m` / `h` / `d` suffixes (`3600s`, `30m`, `24h`, `7d`)
 *   - fractional units are rejected to keep it predictable
 * Returns `undefined` for an unparseable value.
 */
export function parseTtlMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(trimmed);
  if (!match) return undefined;
  const num = Number(match[1]);
  const unit = (match[2] || "ms").toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const milliseconds = num * multipliers[unit];
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

export async function readProfileCache(
  key: ProfileCacheKey,
): Promise<ProfileCache | undefined> {
  try {
    const content = await readFile(profileCachePath(key), "utf-8");
    const parsed = JSON.parse(content) as Partial<ProfileCache>;
    if (
      !Array.isArray(parsed.eligibility) ||
      typeof parsed.fetchedAt !== "string" ||
      parsed.workspaceId !== key.workspaceId ||
      parsed.adminBaseURL !== key.adminBaseURL
    )
      return undefined;
    return parsed as ProfileCache;
  } catch {
    return undefined;
  }
}

export async function writeProfileCache(
  key: ProfileCacheKey,
  cache: ProfileCache,
): Promise<void> {
  const path = profileCachePath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cache, null, 2), "utf-8");
  await removeLegacyHashFiles();
}

/**
 * The cache used to be written as `zmllmgw-profile-cache-<sha256>.json` files in
 * the opencode data dir root, one file per workspace, that were never pruned.
 * Best-effort remove any that remain so they don't accumulate alongside the new
 * per-workspace directories.
 */
async function removeLegacyHashFiles(): Promise<void> {
  const dir = opencodeDataPath("");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => /^zmllmgw-profile-cache-[0-9a-f]{64}\.json$/.test(name))
      .map((name) => unlink(join(dir, name)).catch(() => {})),
  );
}

/** Is the cache old enough to warrant a refresh against the admin API? */
export function isCacheStale(
  cache: ProfileCache,
  ttlMs: number,
  now = Date.now(),
): boolean {
  const fetched = Date.parse(cache.fetchedAt);
  if (Number.isNaN(fetched)) return true;
  return now - fetched >= ttlMs;
}
