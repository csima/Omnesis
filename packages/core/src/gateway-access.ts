// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A Cloudflare Access service token for reaching a gateway that sits behind
 * Cloudflare Access (a Cloudflare Tunnel hostname gated by a Service Auth
 * policy).
 *
 * Access authenticates a machine by two request headers, `CF-Access-Client-Id`
 * and `CF-Access-Client-Secret`, and it checks them on every request,
 * WebSocket upgrades included. They are added at the dispatcher, beneath
 * `fetch` and the `WebSocket` global, so every request this process makes to
 * the gateway carries them without each call site knowing about Access, and
 * they are added per hop: a redirect to another origin — Access sending a
 * refused request to its login page — never carries the secret with it.
 *
 * Only the gateway's own origins receive the headers, and only over `https:`
 * or to a loopback address, where the secret cannot be read off the wire.
 *
 * The token is read from `OMNESIS_ACCESS_CLIENT_ID` with
 * `OMNESIS_ACCESS_CLIENT_SECRET` or `OMNESIS_ACCESS_CLIENT_SECRET_FILE`, or
 * else from `<configDir>/gateway-access-credentials.json`, which is written
 * through the root-key-wrapped secret-file helper like the device token beside
 * it. The secret is never logged and never part of an error message.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import { readSecretJsonFile, writeSecretJsonFile } from "./secret-file.js";
import { resolvesToLoopback } from "./local-gateway-url.js";
import type { Dispatcher } from "undici";

const log = createLogger("gateway-access");

export const ACCESS_CLIENT_ID_HEADER = "CF-Access-Client-Id";
export const ACCESS_CLIENT_SECRET_HEADER = "CF-Access-Client-Secret";

export const ACCESS_CLIENT_ID_ENV = "OMNESIS_ACCESS_CLIENT_ID";
export const ACCESS_CLIENT_SECRET_ENV = "OMNESIS_ACCESS_CLIENT_SECRET";
export const ACCESS_CLIENT_SECRET_FILE_ENV = "OMNESIS_ACCESS_CLIENT_SECRET_FILE";

export const GATEWAY_ACCESS_CREDENTIALS_FILE = "gateway-access-credentials.json";

const MAX_CREDENTIAL_LENGTH = 1024;

export interface GatewayAccessCredentials {
  clientId: string;
  clientSecret: string;
}

export interface LoadedGatewayAccessCredentials extends GatewayAccessCredentials {
  /** Where the token came from: the environment, or the saved file at `path`. */
  source: "env" | "file";
  path?: string;
}

export class GatewayAccessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayAccessConfigError";
  }
}

export function gatewayAccessCredentialsPath(configDir: string): string {
  return join(configDir, GATEWAY_ACCESS_CREDENTIALS_FILE);
}

function validCredentialPart(value: string): boolean {
  return value.length > 0 && value.length <= MAX_CREDENTIAL_LENGTH && /^[\x21-\x7e]+$/u.test(value);
}

/**
 * Validate a client id and secret, trimmed. Neither value is ever quoted back
 * in the refusal: the secret is the credential itself, and a mangled paste of
 * it is still most of one.
 */
export function parseGatewayAccessCredentials(
  clientId: unknown,
  clientSecret: unknown,
): GatewayAccessCredentials {
  const id = typeof clientId === "string" ? clientId.trim() : "";
  const secret = typeof clientSecret === "string" ? clientSecret.trim() : "";
  if (!validCredentialPart(id)) {
    throw new GatewayAccessConfigError(
      "The Cloudflare Access client id must be 1 to 1024 visible ASCII characters, with no spaces.",
    );
  }
  if (!validCredentialPart(secret)) {
    throw new GatewayAccessConfigError(
      "The Cloudflare Access client secret must be 1 to 1024 visible ASCII characters, with no spaces.",
    );
  }
  return { clientId: id, clientSecret: secret };
}

function readSecretFromFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unreadable";
    throw new GatewayAccessConfigError(
      `Cannot read the Cloudflare Access client secret from ${path} (${code}).`,
    );
  }
}

function credentialsFromEnv(env: NodeJS.ProcessEnv): LoadedGatewayAccessCredentials | null {
  const id = env[ACCESS_CLIENT_ID_ENV]?.trim() ?? "";
  const inline = env[ACCESS_CLIENT_SECRET_ENV]?.trim() ?? "";
  const file = env[ACCESS_CLIENT_SECRET_FILE_ENV]?.trim() ?? "";
  if (!id && !inline && !file) return null;
  if (inline && file) {
    throw new GatewayAccessConfigError(
      `Set ${ACCESS_CLIENT_SECRET_ENV} or ${ACCESS_CLIENT_SECRET_FILE_ENV}, not both.`,
    );
  }
  if (!id) {
    throw new GatewayAccessConfigError(
      `A Cloudflare Access client secret is set but ${ACCESS_CLIENT_ID_ENV} is not; set both.`,
    );
  }
  if (!inline && !file) {
    throw new GatewayAccessConfigError(
      `${ACCESS_CLIENT_ID_ENV} is set without a client secret; set ${ACCESS_CLIENT_SECRET_ENV} or ${ACCESS_CLIENT_SECRET_FILE_ENV} too.`,
    );
  }
  const secret = inline || readSecretFromFile(file);
  return { ...parseGatewayAccessCredentials(id, secret), source: "env" };
}

/**
 * The service token this machine reaches its gateway with, or null when none
 * is configured. The environment outranks the saved file, so a service unit
 * or a one-off shell can override what `omnesis gateway access-token set`
 * saved.
 */
export async function readGatewayAccessCredentials(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedGatewayAccessCredentials | null> {
  const fromEnv = credentialsFromEnv(env);
  if (fromEnv) return fromEnv;
  const path = gatewayAccessCredentialsPath(configDir);
  let saved: { clientId?: unknown; clientSecret?: unknown } | null;
  try {
    saved = await readSecretJsonFile<{ clientId?: unknown; clientSecret?: unknown }>(path, {
      configDir,
    });
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new GatewayAccessConfigError(
        `${path} is not a saved Cloudflare Access service token; set it again with \`omnesis gateway access-token set\`.`,
      );
    }
    throw err;
  }
  if (saved === null) return null;
  return {
    ...parseGatewayAccessCredentials(saved.clientId, saved.clientSecret),
    source: "file",
    path,
  };
}

/** Save a service token for this machine, sealed by the install root key when one exists. */
export async function writeGatewayAccessCredentials(
  configDir: string,
  credentials: GatewayAccessCredentials,
): Promise<{ path: string; encrypted: boolean }> {
  const parsed = parseGatewayAccessCredentials(credentials.clientId, credentials.clientSecret);
  const path = gatewayAccessCredentialsPath(configDir);
  const { encrypted } = await writeSecretJsonFile(path, parsed, { configDir });
  return { path, encrypted };
}

/** Remove the saved service token. True when there was one. */
export function removeGatewayAccessCredentials(configDir: string): boolean {
  const path = gatewayAccessCredentialsPath(configDir);
  try {
    rmSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * The origin a gateway URL's requests are dispatched to, when it may carry the
 * token: any `https:` origin, or a loopback `http:` one. Null otherwise, and
 * for anything that is not a URL.
 */
export function gatewayAccessOrigin(gatewayUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    return null;
  }
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && resolvesToLoopback(url.hostname)) return url.origin;
  return null;
}

type HeaderValue = string | string[] | undefined;

/**
 * `headers` as a dispatcher receives them — a flat `[name, value, …]` array,
 * an array or iterable of pairs, or a record — rebuilt as a record with the
 * Access headers set, replacing any a caller supplied itself.
 */
export function withGatewayAccessHeaders(
  headers: unknown,
  credentials: GatewayAccessCredentials,
): Record<string, HeaderValue> {
  const out: Record<string, HeaderValue> = {};
  const reserved = new Set([
    ACCESS_CLIENT_ID_HEADER.toLowerCase(),
    ACCESS_CLIENT_SECRET_HEADER.toLowerCase(),
  ]);
  const add = (name: unknown, value: unknown): void => {
    const key = String(name);
    if (reserved.has(key.toLowerCase())) return;
    const text = Array.isArray(value) ? value.map(String) : String(value);
    const existing = out[key];
    if (existing === undefined) out[key] = text;
    else out[key] = [existing, text].flat();
  };
  if (Array.isArray(headers)) {
    if (headers.length > 0 && Array.isArray(headers[0])) {
      for (const pair of headers as unknown[][]) add(pair[0], pair[1]);
    } else {
      for (let i = 0; i + 1 < headers.length; i += 2) add(headers[i], headers[i + 1]);
    }
  } else if (headers && typeof headers === "object") {
    if (Symbol.iterator in headers) {
      for (const pair of headers as Iterable<unknown[]>) add(pair[0], pair[1]);
    } else {
      for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined) add(name, value);
      }
    }
  }
  out[ACCESS_CLIENT_ID_HEADER] = credentials.clientId;
  out[ACCESS_CLIENT_SECRET_HEADER] = credentials.clientSecret;
  return out;
}

interface AccessState {
  credentials: GatewayAccessCredentials;
  origins: Set<string>;
  interceptor: Dispatcher.DispatcherComposeInterceptor;
  previousDispatcher: Dispatcher | null;
}

let state: AccessState | null = null;

function dispatchOrigin(origin: unknown): string | null {
  if (origin === undefined || origin === null) return null;
  try {
    return new URL(String(origin)).origin;
  } catch {
    return null;
  }
}

function makeInterceptor(): Dispatcher.DispatcherComposeInterceptor {
  return (dispatch) => (opts, handler) => {
    const current = state;
    const origin = dispatchOrigin(opts.origin);
    if (!current || origin === null || !current.origins.has(origin)) {
      return dispatch(opts, handler);
    }
    return dispatch(
      { ...opts, headers: withGatewayAccessHeaders(opts.headers, current.credentials) },
      handler,
    );
  };
}

/**
 * Send `credentials` on every request this process makes to the origins of
 * `gatewayUrls`, including WebSocket upgrades. The first call installs the
 * interceptor on the global dispatcher; later calls add origins. A URL that
 * may not carry the token (plain `http:` to a host that is not this one) is
 * skipped with a warning, so the secret never crosses a network in the clear.
 */
export async function installGatewayAccess(
  gatewayUrls: readonly string[],
  credentials: GatewayAccessCredentials,
): Promise<string[]> {
  const parsed = parseGatewayAccessCredentials(credentials.clientId, credentials.clientSecret);
  const origins: string[] = [];
  for (const url of gatewayUrls) {
    const origin = gatewayAccessOrigin(url);
    if (origin === null) {
      log.warn(
        `Not sending the Cloudflare Access service token to ${url}: only https:// gateway URLs carry it`,
      );
      continue;
    }
    origins.push(origin);
  }
  if (!state) {
    const undici = await import("undici");
    const base =
      process.env.NODE_USE_ENV_PROXY === "1"
        ? new undici.EnvHttpProxyAgent()
        : undici.getGlobalDispatcher();
    const interceptor = makeInterceptor();
    state = {
      credentials: parsed,
      origins: new Set(),
      interceptor,
      previousDispatcher: undici.getGlobalDispatcher(),
    };
    undici.setGlobalDispatcher(base.compose(interceptor));
  } else if (
    state.credentials.clientId !== parsed.clientId ||
    state.credentials.clientSecret !== parsed.clientSecret
  ) {
    state.credentials = parsed;
  }
  for (const origin of origins) {
    if (!state.origins.has(origin)) {
      state.origins.add(origin);
      log.info(`Sending Cloudflare Access service token ${parsed.clientId} to ${origin}`);
    }
  }
  return origins;
}

/**
 * Read this machine's service token and, when there is one, send it to the
 * gateway URLs given. Returns the token's client id and source, or null when
 * none is configured.
 */
export async function enableGatewayAccess(
  gatewayUrls: readonly string[],
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ clientId: string; source: "env" | "file"; origins: string[] } | null> {
  const credentials = await readGatewayAccessCredentials(configDir, env);
  if (!credentials) return null;
  const origins = await installGatewayAccess(gatewayUrls, credentials);
  return { clientId: credentials.clientId, source: credentials.source, origins };
}

/**
 * `dispatcher` with the Access headers added for the gateway's origins, for a
 * request made with a dispatcher of its own rather than the global one.
 */
export function withGatewayAccessDispatcher<D extends Dispatcher>(dispatcher: D): Dispatcher {
  return state ? dispatcher.compose(state.interceptor) : dispatcher;
}

/** The client id sent to `origin`, when this process sends one there. */
export function gatewayAccessClientIdFor(url: string): string | null {
  const origin = gatewayAccessOrigin(url);
  if (!state || origin === null || !state.origins.has(origin)) return null;
  return state.credentials.clientId;
}

/** Undo `installGatewayAccess`, for tests that must leave the process as they found it. */
export async function resetGatewayAccessForTests(): Promise<void> {
  if (!state) return;
  const previous = state.previousDispatcher;
  state = null;
  if (previous) {
    const undici = await import("undici");
    undici.setGlobalDispatcher(previous);
  }
}

/** Cloudflare Access turned a request away before it reached the gateway. */
export class CloudflareAccessRefusedError extends Error {
  readonly code = "OMNESIS_CLOUDFLARE_ACCESS_REFUSED";

  constructor(
    readonly gatewayUrl: string,
    readonly status: number,
    readonly clientId: string | null,
  ) {
    super(
      clientId
        ? `Cloudflare Access refused this machine's service token (client id ${clientId}) for ${gatewayUrl}. ` +
            `Check that the token has not expired or been revoked and that the Access application's Service Auth policy includes it; ` +
            `replace it with \`omnesis gateway access-token set --id <client id> --secret-file <file>\`.`
        : `Cloudflare Access refused this machine for ${gatewayUrl}: the gateway is behind Cloudflare Access and no service token is configured here. ` +
            `Set one with \`omnesis gateway access-token set --id <client id> --secret-file <file>\`, ` +
            `or with ${ACCESS_CLIENT_ID_ENV} and ${ACCESS_CLIENT_SECRET_ENV}.`,
    );
    this.name = "CloudflareAccessRefusedError";
  }
}

export function isCloudflareAccessRefusedError(err: unknown): err is CloudflareAccessRefusedError {
  for (let current = err, depth = 0; current && depth < 8; depth += 1) {
    if (current instanceof CloudflareAccessRefusedError) return true;
    if (
      typeof current === "object" &&
      (current as { code?: unknown }).code === "OMNESIS_CLOUDFLARE_ACCESS_REFUSED"
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isAccessLoginUrl(value: string | null | undefined, base: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value, base);
    return (
      url.hostname.toLowerCase().endsWith(".cloudflareaccess.com") ||
      url.pathname.startsWith("/cdn-cgi/access/")
    );
  } catch {
    return false;
  }
}

export interface AccessCheckedResponse {
  status: number;
  headers: Pick<Headers, "get">;
  url?: string;
  redirected?: boolean;
}

/**
 * Whether `response` to a request for `requestUrl` is Cloudflare Access
 * turning the request away rather than the gateway answering it, as the error
 * to throw. Access refuses a request it cannot authenticate in one of two
 * ways: it redirects to its login page on `<team>.cloudflareaccess.com` — a
 * redirect `fetch` follows, so the page's own 200 reaches the caller — or,
 * under strict service-token authentication, it answers 401 or 403 itself.
 * The gateway answers both of those with JSON, so a 401 or 403 that came
 * through Cloudflare (`cf-ray`) as anything else is Cloudflare's own.
 */
export function cloudflareAccessRefusal(
  requestUrl: string,
  response: AccessCheckedResponse,
): CloudflareAccessRefusedError | null {
  const { status, headers } = response;
  const refused =
    (response.url !== undefined &&
      response.url !== "" &&
      response.redirected === true &&
      isAccessLoginUrl(response.url, requestUrl)) ||
    (status >= 300 && status < 400 && isAccessLoginUrl(headers.get("location"), requestUrl)) ||
    ((status === 401 || status === 403) &&
      headers.get("cf-ray") !== null &&
      !(headers.get("content-type") ?? "").toLowerCase().includes("json"));
  if (!refused) return null;
  let gatewayUrl = requestUrl;
  try {
    gatewayUrl = new URL(requestUrl).origin;
  } catch {
    // Keep the URL as given.
  }
  return new CloudflareAccessRefusedError(gatewayUrl, status, gatewayAccessClientIdFor(requestUrl));
}

/** Throw when `response` is Cloudflare Access refusing the request, discarding its body. */
export async function assertNotCloudflareAccessRefusal(
  requestUrl: string,
  response: Response,
): Promise<void> {
  const refusal = cloudflareAccessRefusal(requestUrl, response);
  if (!refusal) return;
  await response.body?.cancel().catch(() => undefined);
  throw refusal;
}
