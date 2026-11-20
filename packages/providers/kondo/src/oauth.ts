// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

/**
 * OAuth 2.1 against Kondo's authorization server, as the MCP authorization
 * spec lays it out: the protected resource names its authorization server,
 * whose metadata names every endpoint; a public client registers itself
 * dynamically, signs in with PKCE, names the resource it wants a token for,
 * and renews with a refresh token.
 *
 * Only the resource URL is fixed here. Every endpoint is read from metadata at
 * sign-in and stored beside the grant, so a moved endpoint costs a sign-in
 * rather than a release.
 */

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { KONDO_RESOURCE } from "./client.js";

/** `offline_access` is what makes the grant renewable; `openid` names the user. */
const KONDO_SCOPES = "openid offline_access";

const resourceMetadataSchema = z.object({
  resource: z.string().optional(),
  authorization_servers: z.array(z.string().url()).min(1),
});

const serverMetadataSchema = z.object({
  issuer: z.string().optional(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  registration_endpoint: z.string().url().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});
export type AuthServerMetadata = z.infer<typeof serverMetadataSchema>;

const registrationSchema = z.object({ client_id: z.string().min(1) });

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms the access token lapses, when the server said. */
  expiresAt?: number;
  scope?: string;
}

/** Why an OAuth exchange failed, in the terms a caller acts on. */
export class OAuthError extends Error {
  constructor(
    readonly reason: "refused" | "unavailable" | "invalid",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface OAuthDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    throw new OAuthError("unavailable", `Could not reach ${new URL(url).host}: ${describe(err)}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new OAuthError(
      res.status >= 500 ? "unavailable" : "invalid",
      `${url} answered HTTP ${res.status}`,
      res.status,
    );
  }
  return res.json();
}

/**
 * The authorization server's metadata, found from the resource. Tried at the
 * issuer's own path first, which is where Kondo serves it, then where RFC 8414
 * puts it for an issuer with a path.
 */
export async function discoverAuthServer(
  deps: OAuthDeps = {},
  resource: string = KONDO_RESOURCE,
): Promise<AuthServerMetadata> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const origin = new URL(resource).origin;
  const resourceMeta = resourceMetadataSchema.safeParse(
    await getJson(fetchImpl, `${origin}/.well-known/oauth-protected-resource`),
  );
  if (!resourceMeta.success) {
    throw new OAuthError("invalid", "Kondo's resource metadata names no authorization server");
  }
  const issuer = resourceMeta.data.authorization_servers[0].replace(/\/+$/, "");
  const issuerUrl = new URL(issuer);
  const candidates = [
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname}`,
    `${issuer}/.well-known/openid-configuration`,
  ];
  let lastError: unknown;
  for (const url of candidates) {
    try {
      const parsed = serverMetadataSchema.safeParse(await getJson(fetchImpl, url));
      if (parsed.success) return parsed.data;
      lastError = new OAuthError("invalid", `${url} is not authorization server metadata`);
    } catch (err) {
      lastError = err;
      if (err instanceof OAuthError && err.reason === "unavailable") throw err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new OAuthError("invalid", "Kondo's authorization server metadata could not be read");
}

/** Register a public client for one redirect URI (RFC 7591). */
export async function registerClient(
  meta: AuthServerMetadata,
  redirectUri: string,
  deps: OAuthDeps = {},
): Promise<string> {
  if (!meta.registration_endpoint) {
    throw new OAuthError("invalid", "Kondo's authorization server offers no client registration");
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(meta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "Omnesis",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: KONDO_SCOPES,
      }),
    });
  } catch (err) {
    throw new OAuthError("unavailable", `Kondo client registration failed: ${describe(err)}`);
  }
  if (!res.ok) {
    const body = await safeText(res);
    throw new OAuthError(
      res.status >= 500 ? "unavailable" : "invalid",
      `Kondo refused the client registration (HTTP ${res.status})${body ? `: ${body}` : ""}`,
      res.status,
    );
  }
  const parsed = registrationSchema.safeParse(await res.json());
  if (!parsed.success) throw new OAuthError("invalid", "Kondo's registration named no client id");
  return parsed.data.client_id;
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildAuthorizeUrl(
  meta: AuthServerMetadata,
  params: { clientId: string; redirectUri: string; state: string; challenge: string },
  resource: string = KONDO_RESOURCE,
): string {
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", KONDO_SCOPES);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", resource);
  return url.toString();
}

async function tokenRequest(
  tokenEndpoint: string,
  form: Record<string, string>,
  deps: OAuthDeps,
  signal?: AbortSignal,
): Promise<TokenSet> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  let res: Response;
  try {
    res = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new OAuthError(
      "unavailable",
      `Kondo's token endpoint could not be reached: ${describe(err)}`,
    );
  }
  if (!res.ok) {
    const body = await safeText(res);
    const refused = res.status === 400 || res.status === 401;
    throw new OAuthError(
      refused ? "refused" : res.status >= 500 || res.status === 429 ? "unavailable" : "invalid",
      `Kondo's token endpoint answered HTTP ${res.status}${body ? `: ${oauthErrorCode(body)}` : ""}`,
      res.status,
    );
  }
  const parsed = tokenResponseSchema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success)
    throw new OAuthError("invalid", "Kondo's token endpoint sent no access token");
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt:
      parsed.data.expires_in !== undefined ? now() + parsed.data.expires_in * 1000 : undefined,
    scope: parsed.data.scope,
  };
}

export function exchangeCode(
  tokenEndpoint: string,
  params: { clientId: string; code: string; redirectUri: string; verifier: string },
  deps: OAuthDeps = {},
  resource: string = KONDO_RESOURCE,
): Promise<TokenSet> {
  return tokenRequest(
    tokenEndpoint,
    {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.verifier,
      resource,
    },
    deps,
  );
}

export function refreshGrant(
  tokenEndpoint: string,
  params: { clientId: string; refreshToken: string },
  deps: OAuthDeps = {},
  signal?: AbortSignal,
  resource: string = KONDO_RESOURCE,
): Promise<TokenSet> {
  return tokenRequest(
    tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      client_id: params.clientId,
      resource,
    },
    deps,
    signal,
  );
}

/** The `sub` claim of a JWT access token, read without verifying it — a label, never a trust decision. */
export function tokenSubject(accessToken: string): string | undefined {
  const payload = accessToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
    };
    return typeof claims.sub === "string" && claims.sub ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

/** Only the OAuth `error` code of a failure body: descriptions can echo request values. */
function oauthErrorCode(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // not JSON
  }
  return "unrecognised error body";
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
