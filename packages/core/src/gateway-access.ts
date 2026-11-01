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
 * A token is bound to the one gateway origin it was issued for, saved with
 * it: no other URL this process is pointed at receives it, whether named by a
 * later configuration or found on the network. It travels only over `https:`
 * with certificate verification on, or to a loopback address, which is
 * dialled directly and never through a proxy.
 *
 * The token is read from `OMNESIS_ACCESS_CLIENT_ID` with
 * `OMNESIS_ACCESS_CLIENT_SECRET` or `OMNESIS_ACCESS_CLIENT_SECRET_FILE` and
 * `OMNESIS_ACCESS_GATEWAY_URL`, or else from
 * `<configDir>/gateway-access-credentials.json`, which is written through the
 * root-key-wrapped secret-file helper like the device token beside it. An
 * inline secret is removed from the environment once read, so no child
 * process inherits it. The secret is never logged and never part of an error
 * message.
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
export const ACCESS_GATEWAY_URL_ENV = "OMNESIS_ACCESS_GATEWAY_URL";

export const GATEWAY_ACCESS_CREDENTIALS_FILE = "gateway-access-credentials.json";

const MAX_CREDENTIAL_LENGTH = 1024;

export interface GatewayAccessCredentials {
  clientId: string;
  clientSecret: string;
  /** The one gateway origin the token is sent to. */
  gatewayOrigin: string;
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
  gatewayUrl: unknown,
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
  const gatewayOrigin =
    typeof gatewayUrl === "string" ? gatewayAccessOrigin(gatewayUrl.trim()) : null;
  if (gatewayOrigin === null) {
    throw new GatewayAccessConfigError(
      "The Cloudflare Access service token needs the gateway URL it is for: an https:// URL, or http:// to this machine.",
    );
  }
  return { clientId: id, clientSecret: secret, gatewayOrigin };
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

/**
 * The inline secret read from `process.env`, which is then removed from it so
 * that no child process this one starts inherits the credential.
 */
let scrubbedInlineSecret: string | undefined;

function credentialsFromEnv(env: NodeJS.ProcessEnv): LoadedGatewayAccessCredentials | null {
  const id = env[ACCESS_CLIENT_ID_ENV]?.trim() ?? "";
  if (env === process.env && env[ACCESS_CLIENT_SECRET_ENV] !== undefined) {
    scrubbedInlineSecret = env[ACCESS_CLIENT_SECRET_ENV];
    delete env[ACCESS_CLIENT_SECRET_ENV];
  }
  const rawInline =
    env[ACCESS_CLIENT_SECRET_ENV] ?? (env === process.env ? scrubbedInlineSecret : undefined);
  const inline = rawInline?.trim() ?? "";
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
  const gatewayUrl = env[ACCESS_GATEWAY_URL_ENV]?.trim() ?? "";
  if (!gatewayUrl) {
    throw new GatewayAccessConfigError(
      `${ACCESS_CLIENT_ID_ENV} is set without ${ACCESS_GATEWAY_URL_ENV}, the gateway URL the token is for; set it too.`,
    );
  }
  const secret = inline || readSecretFromFile(file);
  return { ...parseGatewayAccessCredentials(id, secret, gatewayUrl), source: "env" };
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
  type Saved = { clientId?: unknown; clientSecret?: unknown; gatewayOrigin?: unknown };
  let saved: Saved | null;
  try {
    saved = await readSecretJsonFile<Saved>(path, { configDir });
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new GatewayAccessConfigError(
        `${path} is not a saved Cloudflare Access service token; set it again with \`omnesis gateway access-token set\`.`,
      );
    }
    throw err;
  }
  if (saved === null) return null;
  if (typeof saved.gatewayOrigin !== "string") {
    throw new GatewayAccessConfigError(
      `${path} names no gateway; set the token again with \`omnesis gateway access-token set --gateway-url <url>\`.`,
    );
  }
  return {
    ...parseGatewayAccessCredentials(saved.clientId, saved.clientSecret, saved.gatewayOrigin),
    source: "file",
    path,
  };
}

/** Save a service token for this machine, sealed by the install root key when one exists. */
export async function writeGatewayAccessCredentials(
  configDir: string,
  credentials: GatewayAccessCredentials,
): Promise<{ path: string; encrypted: boolean }> {
  const parsed = parseGatewayAccessCredentials(
    credentials.clientId,
    credentials.clientSecret,
    credentials.gatewayOrigin,
  );
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

/** `url` with any userinfo removed, for a log line. */
export function redactGatewayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "an unparseable gateway URL";
  }
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
  /** A plain-`http:` (loopback) origin is dialled through this, never a proxy. */
  direct: Dispatcher;
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
    const withHeaders = {
      ...opts,
      headers: withGatewayAccessHeaders(opts.headers, current.credentials),
    };
    // A proxy in the path would read an `http:` request in the clear.
    if (origin.startsWith("http:")) return current.direct.dispatch(withHeaders, handler);
    return dispatch(withHeaders, handler);
  };
}

function tlsVerificationOff(): string | null {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") return "NODE_TLS_REJECT_UNAUTHORIZED=0";
  if (process.env.OMNESIS_INSECURE_TLS) return "OMNESIS_INSECURE_TLS";
  return null;
}

/**
 * Send `credentials` on every request this process makes to the gateway they
 * are bound to, including WebSocket upgrades, when that gateway is among
 * `gatewayUrls`. Any other URL is skipped with a warning (a debug line for a
 * loopback one, which every CLI on a collector machine dials by default). The
 * first match installs the interceptor on the global dispatcher. An `https:`
 * gateway is refused while certificate verification is off: the secret would
 * go to whoever answers.
 */
export async function installGatewayAccess(
  gatewayUrls: readonly string[],
  credentials: GatewayAccessCredentials,
): Promise<string[]> {
  const parsed = parseGatewayAccessCredentials(
    credentials.clientId,
    credentials.clientSecret,
    credentials.gatewayOrigin,
  );
  const origins: string[] = [];
  for (const url of gatewayUrls) {
    const origin = gatewayAccessOrigin(url);
    const shown = redactGatewayUrl(url);
    if (origin === null) {
      log.warn(
        `Not sending the Cloudflare Access service token to ${shown}: only https:// gateway URLs carry it`,
      );
      continue;
    }
    if (origin !== parsed.gatewayOrigin) {
      const line = `Not sending the Cloudflare Access service token to ${shown}: it is bound to ${parsed.gatewayOrigin}`;
      if (resolvesToLoopback(new URL(origin).hostname)) log.debug(line);
      else log.warn(line);
      continue;
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  if (origins.length === 0) return [];
  const insecure = parsed.gatewayOrigin.startsWith("https:") ? tlsVerificationOff() : null;
  if (insecure) {
    throw new GatewayAccessConfigError(
      `Refusing to send the Cloudflare Access service token to ${parsed.gatewayOrigin} while ${insecure} turns certificate verification off; unset it.`,
    );
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
      direct: new undici.Agent(),
    };
    undici.setGlobalDispatcher(base.compose(interceptor));
  } else if (state.credentials.gatewayOrigin !== parsed.gatewayOrigin) {
    state.origins.clear();
    state.credentials = parsed;
  } else {
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
  scrubbedInlineSecret = undefined;
  if (previous) {
    const undici = await import("undici");
    undici.setGlobalDispatcher(previous);
  }
}

/** Cloudflare turned a request away before it reached the gateway. */
export class CloudflareRefusalError extends Error {
  readonly code = "OMNESIS_CLOUDFLARE_REFUSED";

  constructor(
    message: string,
    readonly gatewayUrl: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudflareRefusalError";
  }
}

/** Cloudflare Access refused this machine: its service token, or the lack of one. */
export class CloudflareAccessRefusedError extends CloudflareRefusalError {
  constructor(
    gatewayUrl: string,
    status: number,
    readonly clientId: string | null,
  ) {
    super(
      clientId
        ? `Cloudflare Access refused this machine's service token (client id ${clientId}) for ${gatewayUrl}. ` +
            `Check that the token has not expired or been revoked and that the Access application's Service Auth policy includes it; ` +
            `replace it with \`omnesis gateway access-token set --gateway-url ${gatewayUrl} --id <client id> --secret-file <file>\`.`
        : `Cloudflare Access refused this machine for ${gatewayUrl}: the gateway is behind Cloudflare Access and no service token for it is configured here. ` +
            `Set one with \`omnesis gateway access-token set --gateway-url ${gatewayUrl} --id <client id> --secret-file <file>\`, ` +
            `or with ${ACCESS_CLIENT_ID_ENV}, ${ACCESS_CLIENT_SECRET_ENV} and ${ACCESS_GATEWAY_URL_ENV}.`,
      gatewayUrl,
      status,
    );
    this.name = "CloudflareAccessRefusedError";
  }
}

/** A Cloudflare security rule, not Access, blocked the request. */
export class CloudflareBlockedError extends CloudflareRefusalError {
  constructor(
    gatewayUrl: string,
    status: number,
    readonly ray: string,
  ) {
    super(
      `Cloudflare blocked the request (ray ${ray}) to ${gatewayUrl} with HTTP ${status} before it reached the gateway. ` +
        `A Cloudflare firewall or security rule turned it away, not Cloudflare Access; look the ray ID up in the zone's security events.`,
      gatewayUrl,
      status,
    );
    this.name = "CloudflareBlockedError";
  }
}

function causeChainHas(err: unknown, test: (value: unknown) => boolean): boolean {
  for (let current = err, depth = 0; current && depth < 8; depth += 1) {
    if (test(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Whether `err`, or anything in its cause chain, is Cloudflare refusing a request. */
export function isCloudflareRefusalError(err: unknown): boolean {
  return causeChainHas(
    err,
    (value) =>
      value instanceof CloudflareRefusalError ||
      (typeof value === "object" &&
        value !== null &&
        (value as { code?: unknown }).code === "OMNESIS_CLOUDFLARE_REFUSED"),
  );
}

/** Whether `err`, or anything in its cause chain, is Cloudflare Access refusing this machine. */
export function isCloudflareAccessRefusedError(err: unknown): boolean {
  return causeChainHas(err, (value) => value instanceof CloudflareAccessRefusedError);
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
  headers: Pick<Headers, "get" | "forEach">;
  url?: string;
  redirected?: boolean;
  text?: () => Promise<string>;
}

function hasAccessHeader(headers: Pick<Headers, "forEach">): boolean {
  let found = false;
  headers.forEach((_value, name) => {
    if (name.toLowerCase().startsWith("cf-access-")) found = true;
  });
  return found;
}

/**
 * Whether `response` to a request for `requestUrl` is Cloudflare turning the
 * request away rather than the gateway answering it, as the error to throw.
 *
 * Access refuses a request it cannot authenticate in one of two ways: it
 * redirects to its login page on `<team>.cloudflareaccess.com` (or a
 * `/cdn-cgi/access/` path), or, under strict service-token authentication, it
 * answers 401 or 403 itself. The gateway answers both of those with JSON, so a
 * 401 or 403 that came through Cloudflare (`cf-ray`) as anything else is
 * Cloudflare's own; it is named as Access only when it carries an Access
 * marker — a `cf-access-*` header, or a page that names the Access login —
 * and otherwise as a Cloudflare block, by its ray ID. Reading the page
 * consumes the body, which is only done once the answer is not the gateway's.
 */
export async function cloudflareAccessRefusal(
  requestUrl: string,
  response: AccessCheckedResponse,
): Promise<CloudflareRefusalError | null> {
  const { status, headers } = response;
  let gatewayUrl = requestUrl;
  try {
    gatewayUrl = new URL(requestUrl).origin;
  } catch {
    // Keep the URL as given.
  }
  const access = () =>
    new CloudflareAccessRefusedError(gatewayUrl, status, gatewayAccessClientIdFor(requestUrl));
  const followedToLogin =
    response.redirected === true &&
    response.url !== undefined &&
    response.url !== "" &&
    isAccessLoginUrl(response.url, requestUrl);
  const redirectsToLogin =
    status >= 300 && status < 400 && isAccessLoginUrl(headers.get("location"), requestUrl);
  if (followedToLogin || redirectsToLogin) return access();
  const ray = headers.get("cf-ray");
  if (
    (status !== 401 && status !== 403) ||
    ray === null ||
    (headers.get("content-type") ?? "").toLowerCase().includes("json")
  ) {
    return null;
  }
  if (hasAccessHeader(headers)) return access();
  const page = response.text ? await response.text().catch(() => "") : "";
  if (/\/cdn-cgi\/access\/|\.cloudflareaccess\.com/iu.test(page)) return access();
  return new CloudflareBlockedError(gatewayUrl, status, ray);
}

/** Throw when `response` is Cloudflare refusing the request, discarding its body. */
export async function assertNotCloudflareAccessRefusal(
  requestUrl: string,
  response: Response,
): Promise<void> {
  const refusal = await cloudflareAccessRefusal(requestUrl, response);
  if (!refusal) return;
  if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
  throw refusal;
}
