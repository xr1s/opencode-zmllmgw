import test from "node:test";
import assert from "node:assert/strict";
import {
  exchangeCodeForTokens,
  refreshAccessToken,
  fetchWorkspaceProfile,
  fetchCurrentWorkspaceId,
} from "../src/admin-client.js";

const ADMIN_BASE_URL = "https://admin.example.com";

test("admin-client exchange/refresh/fetchWorkspaceProfile call the right endpoints with the right auth", async () => {
  const calls: Array<{
    url: string;
    method: string;
    body?: string;
    header?: string;
  }> = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      header: headers.get("authorization") ?? undefined,
    });
    const text = url.includes("/api/auth/okta/exchange")
      ? JSON.stringify({ access_token: "at", refresh_token: "rt" })
      : url.includes("/api/auth/okta/refresh")
        ? JSON.stringify({ access_token: "at2" })
        : JSON.stringify({
            current_eligibility: [
              { client_model_config: { model_name: "gpt-5.5" } },
            ],
          });
    return new Response(text, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const ex = await exchangeCodeForTokens({
    baseURL: ADMIN_BASE_URL,
    code: "c",
    redirectUri: "r",
    nonce: "n",
    fetch: fetchImpl,
  });
  assert.equal(ex.access_token, "at");
  assert.equal(ex.refresh_token, "rt");

  const rf = await refreshAccessToken({
    baseURL: ADMIN_BASE_URL,
    refreshToken: "rt",
    fetch: fetchImpl,
  });
  assert.equal(rf.access_token, "at2");

  const prof = await fetchWorkspaceProfile({
    baseURL: ADMIN_BASE_URL,
    accessToken: "at2",
    workspaceId: "workspace-1",
    fetch: fetchImpl,
  });
  assert.equal(prof.eligibility.length, 1);
  assert.ok(
    calls.some((call) =>
      call.url.includes("/api/workspace-model-profiles/workspace-1/access"),
    ),
  );
  assert.ok(calls.some((call) => call.header === "Bearer at2"));
});

test("fetchCurrentWorkspaceId falls back to /api/workspaces when /api/auth/me has no workspace_id", async () => {
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/auth/me")) {
      return new Response(
        JSON.stringify({ email: "user@example.com", role: "user" }),
        { status: 200 },
      );
    }
    if (url.includes("/api/workspaces")) {
      return new Response(
        JSON.stringify({ items: [{ workspace_id: "workspace-1" }] }),
        { status: 200 },
      );
    }
    throw new Error("unexpected url: " + url);
  };
  const id = await fetchCurrentWorkspaceId({
    baseURL: ADMIN_BASE_URL,
    accessToken: "at",
    fetch: fetchImpl,
  });
  assert.equal(id, "workspace-1");
});

test("fetchCurrentWorkspaceId uses /api/auth/me workspace_id when present", async () => {
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/auth/me")) {
      return new Response(
        JSON.stringify({ workspace_id: "workspace-direct" }),
        { status: 200 },
      );
    }
    throw new Error("unexpected url: " + url);
  };
  const id = await fetchCurrentWorkspaceId({
    baseURL: ADMIN_BASE_URL,
    accessToken: "at",
    fetch: fetchImpl,
  });
  assert.equal(id, "workspace-direct");
});
