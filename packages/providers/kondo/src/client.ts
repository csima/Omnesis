// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

/**
 * A thin, read-only client for Kondo's MCP server.
 *
 * Kondo has no REST API. It serves the Model Context Protocol over Streamable
 * HTTP: JSON-RPC 2.0 posted to one endpoint, answered either as a JSON body or
 * as a server-sent event stream, with a session id the server may assign on
 * `initialize`. Every tool result is a JSON text block `{ok, data}`, sometimes
 * followed by a plain-text hint.
 *
 * The client can only call the tools in {@link READ_ONLY_TOOLS}. Kondo's other
 * tools change the inbox or reach LinkedIn directly on the user's behalf, which
 * puts the LinkedIn account at risk; refusing them here, whatever the caller
 * asks, is the guarantee.
 */

import { SyncError } from "@omnesis/types";
import {
  inboxDefinitionSchema,
  inboxRowSchema,
  parseChat,
  statusSchema,
  DEFAULT_TUNING,
} from "./types.js";
import type { KondoChat, KondoInboxRow, KondoStatus, WalkedInbox } from "./types.js";
import type { SyncRemediation } from "@omnesis/types";

const KONDO_MCP_URL = "https://relay.trykondo.com/mcp";
export const KONDO_RESOURCE = "https://relay.trykondo.com";

const PROTOCOL_VERSION = "2025-06-18";

export const READ_ONLY_TOOLS = [
  "read_status",
  "list_inboxes",
  "list_inbox",
  "read_chat",
  "read_connection",
] as const;
export type ReadOnlyTool = (typeof READ_ONLY_TOOLS)[number];

const MORE_RESULTS = /more results may be available/i;

/** Where the bearer token comes from: a stored grant, or one held in memory during sign-in. */
export interface TokenSource {
  /** The token to send, renewed first when it is about to lapse. */
  accessToken(signal?: AbortSignal): Promise<string>;
  /**
   * Renew after the server refused `rejected`. Throws a `SyncError("auth")`
   * when the grant itself is gone.
   */
  refresh(rejected: string, signal?: AbortSignal): Promise<string>;
}

export interface KondoClientOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  callGapMs?: number;
  requestTimeoutMs?: number;
  clientVersion?: string;
}

export const TAB_REMEDIATION: SyncRemediation = {
  summary: "Open Kondo in one Chrome tab",
  steps: [
    "Kondo answers only while the Kondo extension has a tab open. Open app.trykondo.com in one Chrome tab and keep it open.",
    "The next sync continues where this one stopped.",
  ],
  restartRequired: false,
};

/** The failure every caller sees when no Kondo tab is connected. */
export function tabDisconnectedError(lastSeenAt?: string | null): SyncError {
  const seen = lastSeenAt ? ` (last seen ${lastSeenAt})` : "";
  return new SyncError(
    "transient",
    `Kondo is not connected to a browser tab${seen}. Open Kondo in one Chrome tab.`,
    { remediation: TAB_REMEDIATION },
  );
}

export interface ToolResult {
  ok: boolean;
  data: unknown;
  error?: string;
  /** Plain-text blocks after the JSON one. */
  hints: string[];
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class KondoClient {
  private readonly tokens: TokenSource;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly callGapMs: number;
  private readonly requestTimeoutMs: number;
  private readonly clientVersion: string;
  private sessionId: string | undefined;
  private negotiatedVersion: string | undefined;
  private initialized: Promise<void> | undefined;
  private nextId = 1;
  private lastCallAt = 0;

  constructor(tokens: TokenSource, opts: KondoClientOptions = {}) {
    this.tokens = tokens;
    this.endpoint = opts.endpoint ?? KONDO_MCP_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.callGapMs = opts.callGapMs ?? DEFAULT_TUNING.callGapMs;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_TUNING.requestTimeoutMs;
    this.clientVersion = opts.clientVersion ?? "0";
  }

  async readStatus(signal?: AbortSignal): Promise<KondoStatus> {
    const result = await this.callTool("read_status", {}, signal);
    const parsed = statusSchema.safeParse(result.data);
    if (!result.ok || !parsed.success) {
      throw new SyncError(
        "transient",
        `Kondo could not report its connection status${result.error ? `: ${result.error}` : "."}`,
      );
    }
    return parsed.data;
  }

  /** Label names by key, for the labels a chat carries. */
  async listLabels(signal?: AbortSignal): Promise<Record<string, string>> {
    const result = await this.checkedTool("list_inboxes", {}, signal);
    const labels: Record<string, string> = {};
    for (const row of Array.isArray(result.data) ? result.data : []) {
      const parsed = inboxDefinitionSchema.safeParse(row);
      if (parsed.success && parsed.data.isLabel && parsed.data.name.trim()) {
        labels[parsed.data.key] = parsed.data.name.trim();
      }
    }
    return labels;
  }

  /** One page of an inbox, newest activity first. */
  async listInbox(
    params: { inbox: WalkedInbox; limit: number; before?: number; after?: number },
    signal?: AbortSignal,
  ): Promise<{ rows: KondoInboxRow[]; more: boolean; skipped: number }> {
    const args: Record<string, unknown> = {
      inbox: params.inbox,
      limit: params.limit,
      view: "EVERYTHING",
    };
    if (params.before !== undefined) args.before = params.before;
    if (params.after !== undefined) args.after = params.after;
    const result = await this.checkedTool("list_inbox", args, signal);
    const rows: KondoInboxRow[] = [];
    let skipped = 0;
    for (const row of Array.isArray(result.data) ? result.data : []) {
      const parsed = inboxRowSchema.safeParse(row);
      if (parsed.success) rows.push(parsed.data);
      else skipped++;
    }
    return { rows, more: result.hints.some((h) => MORE_RESULTS.test(h)), skipped };
  }

  /** Read several chats in one call. Chats Kondo leaves out are simply absent. */
  async readChats(
    chats: ReadonlyArray<{ profileUrn: string; threadKey: string }>,
    signal?: AbortSignal,
  ): Promise<{ chats: KondoChat[]; skipped: number }> {
    const result = await this.checkedTool(
      "read_chat",
      { chats: chats.map((c) => ({ profileUrn: c.profileUrn, threadKey: c.threadKey })) },
      signal,
    );
    const out: KondoChat[] = [];
    let skipped = 0;
    for (const row of Array.isArray(result.data) ? result.data : []) {
      const chat = parseChat(row);
      if (chat) out.push(chat);
      else skipped++;
    }
    return { chats: out, skipped };
  }

  /**
   * A tool call whose `ok: false` is explained. Without a connected tab Kondo
   * refuses everything but `read_status`, and that is the one condition the
   * operator can fix, so a refusal asks the status before saying anything.
   */
  private async checkedTool(
    name: ReadOnlyTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const result = await this.callTool(name, args, signal);
    if (result.ok) return result;
    const status = await this.readStatus(signal).catch(() => undefined);
    if (status && !status.connected) throw tabDisconnectedError(status.lastSeenAt);
    throw new SyncError(
      "transient",
      `Kondo refused ${name}${result.error ? `: ${result.error}` : "."}`,
    );
  }

  async callTool(
    name: ReadOnlyTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (!(READ_ONLY_TOOLS as readonly string[]).includes(name)) {
      throw new Error(
        `Refusing to call Kondo tool ${String(name)}: only read-only tools are allowed`,
      );
    }
    if (args.linkedin !== undefined) {
      throw new Error("Refusing to ask Kondo to read LinkedIn directly");
    }
    await this.ensureInitialized(signal);
    await this.pace();
    const result = await this.rpc("tools/call", { name, arguments: args }, signal);
    return parseToolResult(result);
  }

  private async pace(): Promise<void> {
    const wait = this.lastCallAt + this.callGapMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastCallAt = Date.now();
  }

  private ensureInitialized(signal?: AbortSignal): Promise<void> {
    this.initialized ??= this.initialize(signal).catch((err: unknown) => {
      this.initialized = undefined;
      throw err;
    });
    return this.initialized;
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    this.sessionId = undefined;
    const result = (await this.rpc(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "omnesis", version: this.clientVersion },
      },
      signal,
      { initializing: true },
    )) as { protocolVersion?: unknown } | undefined;
    this.negotiatedVersion =
      typeof result?.protocolVersion === "string" ? result.protocolVersion : PROTOCOL_VERSION;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal, {
      notification: true,
    });
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    opts: { initializing?: boolean } = {},
  ): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal, {
      expectId: id,
      initializing: opts.initializing,
    });
    if (!response) throw new SyncError("transient", `Kondo sent no answer to ${method}.`);
    if (response.error) {
      throw new SyncError(
        "transient",
        `Kondo refused ${method}: ${truncate(response.error.message ?? "")} (JSON-RPC ${response.error.code})`,
      );
    }
    return response.result;
  }

  private async post(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    opts: {
      expectId?: number;
      notification?: boolean;
      initializing?: boolean;
      reauthorized?: boolean;
      reinitialized?: boolean;
    },
  ): Promise<JsonRpcResponse | undefined> {
    const token = await this.tokens.accessToken(signal);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.negotiatedVersion && !opts.initializing) {
      headers["MCP-Protocol-Version"] = this.negotiatedVersion;
    }
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new SyncError("network", `Kondo could not be reached: ${describe(err)}`, {
        cause: err,
      });
    }

    if (res.status === 401 && !opts.reauthorized) {
      await res.body?.cancel().catch(() => undefined);
      await this.tokens.refresh(token, signal);
      return this.post(body, signal, { ...opts, reauthorized: true });
    }
    if (res.status === 404 && this.sessionId && !opts.initializing && !opts.reinitialized) {
      // The server forgot the session; the spec's answer is a fresh one.
      await res.body?.cancel().catch(() => undefined);
      this.initialized = undefined;
      await this.ensureInitialized(signal);
      return this.post(body, signal, { ...opts, reinitialized: true });
    }
    if (!res.ok) throw await httpFailure(res);

    const assigned = res.headers.get("mcp-session-id");
    if (assigned) this.sessionId = assigned;
    if (opts.notification) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }

    const type = res.headers.get("content-type") ?? "";
    try {
      if (type.includes("text/event-stream")) return await readEventStream(res, opts.expectId);
      const parsed = (await res.json()) as JsonRpcResponse | JsonRpcResponse[];
      return Array.isArray(parsed) ? parsed.find((m) => m.id === opts.expectId) : parsed;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof SyncError) throw err;
      throw new SyncError("transient", `Kondo sent an unreadable answer: ${describe(err)}`, {
        cause: err,
      });
    }
  }
}

/** The JSON block and the hints of a `tools/call` result. */
export function parseToolResult(result: unknown): ToolResult {
  const r = (result ?? {}) as { content?: unknown; isError?: unknown };
  const blocks = Array.isArray(r.content) ? r.content : [];
  const texts = blocks
    .filter((b): b is { type: "text"; text: string } => {
      const block = b as { type?: unknown; text?: unknown };
      return block.type === "text" && typeof block.text === "string";
    })
    .map((b) => b.text);
  type Payload = { ok?: unknown; data?: unknown; error?: unknown; message?: unknown };
  let payload: Payload | undefined;
  let jsonIndex = -1;
  for (let i = 0; i < texts.length && payload === undefined; i++) {
    try {
      const parsed = JSON.parse(texts[i]) as unknown;
      if (parsed && typeof parsed === "object" && "ok" in parsed) {
        payload = parsed as Payload;
        jsonIndex = i;
      }
    } catch {
      continue;
    }
  }
  const hints = texts.filter((_, i) => i !== jsonIndex);
  if (!payload) {
    return { ok: false, data: undefined, error: truncate(texts.join(" ") || "no result"), hints };
  }
  const ok = payload.ok === true && r.isError !== true;
  return {
    ok,
    data: payload.data,
    error: ok ? undefined : errorText(payload.error ?? payload.message ?? payload.data),
    hints,
  };
}

function errorText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return truncate(value);
  const message = (value as { message?: unknown }).message;
  if (typeof message === "string") return truncate(message);
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

/**
 * Read server-sent events until the response to `expectId` arrives. The
 * stream may stay open after it, so it is cancelled rather than drained.
 */
async function readEventStream(
  res: Response,
  expectId: number | undefined,
): Promise<JsonRpcResponse | undefined> {
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n?/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const message = parseEvent(event);
        if (message && (expectId === undefined || message.id === expectId)) return message;
      }
      if (done) {
        const message = parseEvent(buffer);
        if (message && (expectId === undefined || message.id === expectId)) return message;
        return undefined;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseEvent(event: string): JsonRpcResponse | undefined {
  const data = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data.trim()) return undefined;
  const parsed = JSON.parse(data) as JsonRpcResponse;
  return parsed && typeof parsed === "object" && "id" in parsed ? parsed : undefined;
}

async function httpFailure(res: Response): Promise<SyncError> {
  const body = truncate(await res.text().catch(() => ""));
  const detail = body ? `: ${body}` : ".";
  if (res.status === 401) {
    return new SyncError("auth", `Kondo refused the sign-in (HTTP 401)${detail}`, {
      scope: "connection",
    });
  }
  if (res.status === 403) {
    return new SyncError("permission", `Kondo refused the request (HTTP 403)${detail}`);
  }
  if (res.status === 429) {
    return new SyncError("rate-limit", "Kondo is rate limiting requests (HTTP 429).", {
      retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")) ?? 60_000,
      quota: { kind: "account" },
    });
  }
  if (res.status >= 500) {
    return new SyncError("transient", `Kondo server error (HTTP ${res.status})${detail}`);
  }
  return new SyncError("unknown", `Kondo request failed (HTTP ${res.status})${detail}`);
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

const MAX_DETAIL = 200;

function truncate(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
