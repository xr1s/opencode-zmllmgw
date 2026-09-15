import test from "node:test";
import assert from "node:assert/strict";
import {
  createAdminAuthHook,
  DEFAULT_ADMIN_AUTH_METHOD_ID,
} from "../src/auth-hook.js";

const ADMIN_BASE_URL = "https://admin.example.com";
const ADMIN_PROVIDER_ID = "zmllmadm";
const ISSUER = "https://idp.example.com/oauth2/default";

function jwtWithExpiry(exp: number): string {
  return `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
}

function oktaConfig() {
  return JSON.stringify({ clientID: "cid", enabled: true, issuer: ISSUER });
}

test("createAdminAuthHook registers a V2 OAuth method and builds an Okta URL", async () => {
  let fetchedConfig = false;
  const fetchImpl: typeof globalThis.fetch = async () => {
    fetchedConfig = true;
    return new Response(oktaConfig(), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const registration = createAdminAuthHook({
    adminBaseURL: ADMIN_BASE_URL,
    adminProviderID: ADMIN_PROVIDER_ID,
    fetch: fetchImpl,
  });
  assert.equal(registration.integrationID, ADMIN_PROVIDER_ID);
  assert.deepEqual(registration.method, {
    id: DEFAULT_ADMIN_AUTH_METHOD_ID,
    type: "oauth",
    label: "ZMLLMADM (OAuth)",
  });

  const result = await registration.authorize({});
  assert.equal(result.mode, "code");
  assert.ok(result.url.includes("/v1/authorize"));
  assert.ok(result.url.includes("client_id=cid"));
  assert.ok(
    result.url.includes(
      `redirect_uri=${encodeURIComponent(`${ADMIN_BASE_URL}/auth/okta/callback`)}`,
    ),
  );
  assert.ok(fetchedConfig);
});

test("createAdminAuthHook uses distinct state and nonce", async () => {
  const fetchImpl: typeof globalThis.fetch = async () =>
    new Response(oktaConfig(), { status: 200 });
  const result = await createAdminAuthHook({
    adminBaseURL: ADMIN_BASE_URL,
    adminProviderID: ADMIN_PROVIDER_ID,
    fetch: fetchImpl,
  }).authorize({});
  const query = new URL(result.url).searchParams;
  assert.notEqual(query.get("state"), query.get("nonce"));
});

test("createAdminAuthHook exchanges and refreshes OAuth credentials with millisecond expiry", async () => {
  const calls: string[] = [];
  const accessToken = jwtWithExpiry(1_900_000_000);
  const refreshedToken = jwtWithExpiry(1_900_000_100);
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/auth/okta/config")) {
      return new Response(oktaConfig(), { status: 200 });
    }
    if (url.endsWith("/api/auth/okta/exchange")) {
      return new Response(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: "refresh-1",
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/api/auth/okta/refresh")) {
      return new Response(JSON.stringify({ access_token: refreshedToken }), {
        status: 200,
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const registration = createAdminAuthHook({
    adminBaseURL: ADMIN_BASE_URL,
    adminProviderID: ADMIN_PROVIDER_ID,
    fetch: fetchImpl,
  });
  const authorization = await registration.authorize({});
  if (authorization.mode !== "code")
    throw new Error("expected authorization code flow");
  const credential = await authorization.callback("code");
  assert.equal(credential.type, "oauth");
  assert.equal(credential.access, accessToken);
  assert.equal(credential.refresh, "refresh-1");
  assert.equal(credential.expires, 1_900_000_000_000);

  const refreshed = await registration.refresh!(credential);
  assert.equal(refreshed.access, refreshedToken);
  assert.equal(refreshed.refresh, "refresh-1");
  assert.equal(refreshed.expires, 1_900_000_100_000);
  assert.deepEqual(calls, [
    `${ADMIN_BASE_URL}/api/auth/okta/config`,
    `${ADMIN_BASE_URL}/api/auth/okta/exchange`,
    `${ADMIN_BASE_URL}/api/auth/okta/refresh`,
  ]);
});
