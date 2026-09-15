/**
 * OAuth integration registration for the llm-admin Okta flow.
 *
 * OpenCode stores credentials through integrations. The authorization-code flow
 * still uses llm-admin's callback because the Okta application only allows that
 * origin as its redirect URI. Both the admin provider ID and its base URL come
 * from the configuration file; this hook is only created once an admin endpoint
 * is configured.
 */

import { randomUUID } from "node:crypto";
import type { Credential } from "@opencode/plugin";
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration";
import {
  exchangeCodeForTokens,
  fetchOktaConfig,
  refreshAccessToken,
} from "./admin-client.js";

// Keep the method ID used by credentials migrated from a legacy auth store.
export const DEFAULT_ADMIN_AUTH_METHOD_ID = "oauth";

export type AdminAuthHookOptions = {
  /** llm-admin base URL (required; resolved from configuration). */
  adminBaseURL: string;
  /** Integration ID used to register the admin connection. */
  adminProviderID: string;
  fetch?: typeof globalThis.fetch;
};

const OAUTH_SCOPES = "openid email profile offline_access";

/** Decode the `exp` (seconds, epoch) from a JWT access token, if parseable. */
function jwtExpSeconds(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(
        parts[1].replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString(),
    );
    return typeof payload.exp === "number" ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

function oauthCredential(
  access: string,
  refresh: string,
  expires: number,
): Credential.OAuth {
  return {
    type: "oauth",
    methodID: DEFAULT_ADMIN_AUTH_METHOD_ID,
    refresh,
    access,
    expires,
  } as Credential.OAuth;
}

export function createAdminAuthHook(
  options: AdminAuthHookOptions,
): IntegrationOAuthMethodRegistration {
  const adminBaseURL = options.adminBaseURL.replace(/\/+$/, "");
  const adminProviderID = options.adminProviderID;

  let pending: { nonce: string; redirectUri: string } | undefined;

  return {
    integrationID: adminProviderID,
    method: {
      id: DEFAULT_ADMIN_AUTH_METHOD_ID,
      type: "oauth",
      label: "ZMLLMADM (OAuth)",
    },
    authorize: async () => {
      const config = await fetchOktaConfig({
        baseURL: adminBaseURL,
        fetch: options.fetch,
        signal: undefined,
      });
      const state = randomUUID();
      const nonce = randomUUID();
      const redirectUri = `${adminBaseURL}/auth/okta/callback`;
      pending = { nonce, redirectUri };

      const url = new URL(`${config.issuer.replace(/\/+$/, "")}/v1/authorize`);
      url.searchParams.set("client_id", config.clientID);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", OAUTH_SCOPES);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);

      return {
        url: url.toString(),
        instructions:
          "Open the link and sign in with Okta. After signing in you will be redirected to " +
          "the admin site and the page may show \u201cInvalid Okta callback state.\u201d \u2014 that is expected " +
          "(the admin site does not know about this login) and is harmless. Look at the browser " +
          "address bar, copy the value after `?code=` (ignore everything else), and paste it back here.",
        mode: "code" as const,
        callback: async (code: string) => {
          const current = pending;
          pending = undefined;
          if (!current || !code)
            throw new Error("ZMLLMGW: authorization code is missing");
          const tokens = await exchangeCodeForTokens({
            baseURL: adminBaseURL,
            code,
            redirectUri: current.redirectUri,
            nonce: current.nonce,
            fetch: options.fetch,
            signal: undefined,
          });
          if (!tokens.refresh_token)
            throw new Error(
              "ZMLLMGW: token exchange returned no refresh token",
            );
          const expires =
            (jwtExpSeconds(tokens.access_token) ??
              Math.floor(Date.now() / 1000) + 3600) * 1000;
          return oauthCredential(
            tokens.access_token,
            tokens.refresh_token,
            expires,
          );
        },
      };
    },
    refresh: async (credential) => {
      const tokens = await refreshAccessToken({
        baseURL: adminBaseURL,
        refreshToken: credential.refresh,
        fetch: options.fetch,
        signal: undefined,
      });
      const refresh = tokens.refresh_token ?? credential.refresh;
      const expires =
        (jwtExpSeconds(tokens.access_token) ??
          Math.floor(Date.now() / 1000) + 3600) * 1000;
      return oauthCredential(tokens.access_token, refresh, expires);
    },
  };
}
