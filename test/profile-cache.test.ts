import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTtlMs,
  isCacheStale,
  profileCachePath,
  type ProfileCache,
} from "../src/profile-cache.js";

test("parseTtlMs supports plain ms, and s/m/h/d suffixes", () => {
  assert.equal(parseTtlMs(3000), 3000);
  assert.equal(parseTtlMs("3000ms"), 3000);
  assert.equal(parseTtlMs("3600s"), 3_600_000);
  assert.equal(parseTtlMs("30m"), 1_800_000);
  assert.equal(parseTtlMs("24h"), 86_400_000);
  assert.equal(parseTtlMs("7d"), 604_800_000);
  assert.equal(parseTtlMs(undefined), undefined);
  assert.equal(parseTtlMs(-1), undefined);
  assert.equal(parseTtlMs("nonsense"), undefined);
});

test("profile cache paths are isolated per workspace and use a readable dir", () => {
  const first = profileCachePath({
    adminBaseURL: "https://admin.example",
    workspaceId: "workspace-a",
  });
  const second = profileCachePath({
    adminBaseURL: "https://admin.example",
    workspaceId: "workspace-b",
  });
  const third = profileCachePath({
    adminBaseURL: "https://other-admin.example",
    workspaceId: "workspace-a",
  });
  // Different workspaces land in different directories.
  assert.notEqual(first, second);
  // Same workspace id keeps a single fixed file name regardless of endpoint.
  assert.equal(first, third);
  // The file name is fixed (only the latest version is kept) and the path
  // is human-readable: no hash suffix.
  assert.match(first, /profile\.json$/);
  assert.match(first, /zmllmgw-profiles/);
  assert.doesNotMatch(first, /[0-9a-f]{64}/);
});

test("isCacheStale reports freshness vs the TTL window", () => {
  const cache: ProfileCache = {
    fetchedAt: new Date(Date.now() - 60_000).toISOString(),
    workspaceId: "workspace",
    adminBaseURL: "https://admin.example",
    eligibility: [],
  };
  assert.equal(isCacheStale(cache, 7 * 86_400_000), false);
  assert.equal(isCacheStale(cache, 1000), true);
  const malformed: ProfileCache = {
    fetchedAt: "not-a-date",
    workspaceId: "workspace",
    adminBaseURL: "https://admin.example",
    eligibility: [],
  };
  assert.equal(isCacheStale(malformed, 86_400_000), true);
});
