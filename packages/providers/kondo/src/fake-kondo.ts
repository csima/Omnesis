// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

/**
 * An in-process stand-in for Kondo: its resource and authorization-server
 * metadata, dynamic client registration, the PKCE token endpoint with rotating
 * refresh tokens, and the Streamable HTTP MCP endpoint with the read-only
 * tools. Served through an injected `fetch`; every person, id and message in
 * it is invented.
 */

import { createHash, randomUUID } from "node:crypto";

const RESOURCE_ORIGIN = "https://relay.trykondo.com";
export const ISSUER = "https://supa.trykondo.com/auth/v1";

export interface FakeParticipant {
  fullName: string;
  profileUrn: string;
  profileUrl: string;
}

export const OWNER_URN = "100000001";
export const OWNER: FakeParticipant = {
  fullName: "Sarah Mendez",
  profileUrn: OWNER_URN,
  profileUrl: "https://www.linkedin.com/in/sarah-mendez-example",
};
export const MAYA: FakeParticipant = {
  fullName: "Maya Reeves",
  profileUrn: "100000002",
  profileUrl: "https://www.linkedin.com/in/maya-reeves-example/",
};
export const JAMIE: FakeParticipant = {
  fullName: "Jamie Lopez",
  profileUrn: "100000003",
  profileUrl: "https://www.linkedin.com/in/jamie-lopez-example",
};
export const DAVID: FakeParticipant = {
  fullName: "David Lin",
  profileUrn: "100000004",
  profileUrl: "https://www.linkedin.com/in/david-lin-example",
};

export interface FakeMessage {
  sender: string;
  self: boolean;
  time: string;
  text: string;
}

interface FakeChat {
  profileUrn: string;
  threadKey: string;
  participants: FakeParticipant[];
  messages: FakeMessage[];
  labelKeys: string[];
  archived: boolean;
  activityAt?: number;
}

export const SUBJECT = "4f9c2a10-0000-4000-8000-000000000001";

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

const READ_ONLY = new Set([
  "read_status",
  "list_inboxes",
  "list_inbox",
  "read_chat",
  "read_connection",
]);

export class FakeKondo {
  tabConnected = true;
  /** Answer MCP requests as server-sent events instead of JSON. */
  sse = false;
  /** Statuses the next MCP posts answer with, before anything else. */
  readonly failNext: number[] = [];
  /** Every tool call, in order. */
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  /** Tools called that the source must never call. */
  readonly forbidden: string[] = [];
  readonly registrations: Array<{ clientId: string; redirectUris: string[]; body: unknown }> = [];
  readonly tokenRequests: Array<Record<string, string>> = [];
  refreshRefused = false;
  /** Tools that answer `ok: false` while the tab is connected. */
  readonly refuse = new Set<string>();
  /** When false, `initialize` assigns no session id. */
  assignSession = true;

  private readonly chats = new Map<string, FakeChat>();
  private readonly labels = [
    { key: "all", name: "All", category: "inbox", isLabel: false, isComposite: true },
    { key: "lbl-hiring", name: "Hiring", category: "label", isLabel: true, isComposite: false },
  ];
  private readonly codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; resource?: string }
  >();
  private readonly accessTokens = new Set<string>();
  private readonly refreshTokens = new Map<string, string>();
  private readonly sessions = new Set<string>();
  private serial = 0;

  addChat(chat: {
    threadKey: string;
    participants: FakeParticipant[];
    messages?: FakeMessage[];
    labelKeys?: string[];
    archived?: boolean;
    profileUrn?: string;
    activityAt?: number;
  }): void {
    this.chats.set(chat.threadKey, {
      profileUrn: chat.profileUrn ?? OWNER_URN,
      threadKey: chat.threadKey,
      participants: chat.participants,
      messages: chat.messages ?? [],
      labelKeys: chat.labelKeys ?? [],
      archived: chat.archived ?? false,
      activityAt: chat.activityAt,
    });
  }

  post(threadKey: string, message: FakeMessage): void {
    const chat = this.chats.get(threadKey);
    if (!chat) throw new Error(`no chat ${threadKey}`);
    chat.messages.push(message);
    chat.activityAt = undefined;
  }

  archive(threadKey: string): void {
    this.chats.get(threadKey)!.archived = true;
  }

  /** Every access token now in circulation stops working, as an expiry would. */
  expireAccessTokens(): void {
    this.accessTokens.clear();
  }

  /** The server forgets every MCP session. */
  dropSessions(): void {
    this.sessions.clear();
  }

  toolCalls(name?: string): Array<{ name: string; args: Record<string, unknown> }> {
    return name ? this.calls.filter((c) => c.name === name) : this.calls;
  }

  /** Mint a grant directly, as a completed sign-in would have. */
  issueGrant(clientId = "client-preissued"): {
    accessToken: string;
    refreshToken: string;
    clientId: string;
  } {
    const { access, refresh } = this.mint(clientId);
    return { accessToken: access, refreshToken: refresh, clientId };
  }

  /**
   * What the browser does: the user approves on Kondo's consent page and is
   * sent back to the redirect with a code. Returns that redirect URL.
   */
  approve(authorizeUrl: string, opts: { deny?: boolean } = {}): string {
    const url = new URL(authorizeUrl);
    const clientId = url.searchParams.get("client_id")!;
    const redirectUri = url.searchParams.get("redirect_uri")!;
    const state = url.searchParams.get("state")!;
    const reg = this.registrations.find((r) => r.clientId === clientId);
    if (!reg || !reg.redirectUris.includes(redirectUri)) throw new Error("unregistered redirect");
    if (url.searchParams.get("code_challenge_method") !== "S256") throw new Error("PKCE required");
    const back = new URL(redirectUri);
    back.searchParams.set("state", state);
    if (opts.deny) {
      back.searchParams.set("error", "access_denied");
      return back.toString();
    }
    const code = `code-${++this.serial}`;
    this.codes.set(code, {
      clientId,
      redirectUri,
      challenge: url.searchParams.get("code_challenge")!,
      resource: url.searchParams.get("resource") ?? undefined,
    });
    back.searchParams.set("code", code);
    return back.toString();
  }

  readonly fetch: typeof fetch = (input, init) => Promise.resolve(this.route(input, init));

  private route(input: Parameters<typeof fetch>[0], init?: RequestInit): Response {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    const method = init?.method ?? "GET";
    const path = `${url.origin}${url.pathname}`;
    if (path === `${RESOURCE_ORIGIN}/.well-known/oauth-protected-resource`) {
      return json({
        resource: RESOURCE_ORIGIN,
        authorization_servers: [ISSUER],
        bearer_methods_supported: ["header"],
      });
    }
    if (path === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        registration_endpoint: `${ISSUER}/oauth/clients/register`,
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256", "plain"],
      });
    }
    if (path === `${ISSUER}/oauth/clients/register` && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { redirect_uris: string[] };
      const clientId = `client-${++this.serial}`;
      this.registrations.push({ clientId, redirectUris: body.redirect_uris, body });
      return json({ client_id: clientId, redirect_uris: body.redirect_uris }, 201);
    }
    if (path === `${ISSUER}/oauth/token` && method === "POST") {
      return this.token(Object.fromEntries(new URLSearchParams(String(init?.body))));
    }
    if (path === `${RESOURCE_ORIGIN}/mcp` && method === "POST") {
      return this.mcp(init);
    }
    return new Response("not found", { status: 404 });
  }

  private mint(clientId: string): { access: string; refresh: string } {
    const n = ++this.serial;
    const access = `${b64url({ alg: "none" })}.${b64url({ sub: SUBJECT, n })}.sig`;
    const refresh = `refresh-${n}`;
    this.accessTokens.add(access);
    this.refreshTokens.set(refresh, clientId);
    return { access, refresh };
  }

  private token(form: Record<string, string>): Response {
    this.tokenRequests.push(form);
    if (form.grant_type === "authorization_code") {
      const grant = this.codes.get(form.code);
      this.codes.delete(form.code);
      const expected = form.code_verifier
        ? createHash("sha256").update(form.code_verifier).digest("base64url")
        : undefined;
      if (
        !grant ||
        grant.clientId !== form.client_id ||
        grant.redirectUri !== form.redirect_uri ||
        grant.challenge !== expected
      ) {
        return json({ error: "invalid_grant" }, 400);
      }
      const { access, refresh } = this.mint(form.client_id);
      return json({
        access_token: access,
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: refresh,
      });
    }
    if (form.grant_type === "refresh_token") {
      const owner = this.refreshTokens.get(form.refresh_token);
      if (this.refreshRefused || !owner || owner !== form.client_id) {
        return json({ error: "invalid_grant" }, 400);
      }
      this.refreshTokens.delete(form.refresh_token);
      const { access, refresh } = this.mint(owner);
      return json({
        access_token: access,
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: refresh,
      });
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }

  private mcp(init: RequestInit | undefined): Response {
    const failure = this.failNext.shift();
    if (failure !== undefined) {
      return new Response("upstream trouble", {
        status: failure,
        headers: failure === 429 ? { "retry-after": "30" } : {},
      });
    }
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization") ?? "";
    if (!this.accessTokens.has(auth.replace(/^Bearer /, ""))) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${RESOURCE_ORIGIN}/.well-known/oauth-protected-resource"`,
        },
      });
    }
    if (!(headers.get("accept") ?? "").includes("text/event-stream")) {
      return new Response("Not Acceptable", { status: 406 });
    }
    const body = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (body.method === "initialize") {
      const session = randomUUID();
      if (this.assignSession) this.sessions.add(session);
      return this.reply(
        body.id,
        {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "kondo-fake", version: "1" },
        },
        this.assignSession ? { "mcp-session-id": session } : {},
      );
    }
    const session = headers.get("mcp-session-id");
    if (this.assignSession && (!session || !this.sessions.has(session))) {
      return new Response("session not found", { status: 404 });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method !== "tools/call") {
      return this.replyError(body.id, -32601, "Method not found");
    }
    const name = body.params?.name ?? "";
    const args = body.params?.arguments ?? {};
    this.calls.push({ name, args });
    if (!READ_ONLY.has(name)) {
      this.forbidden.push(name);
      return this.reply(body.id, toolResult({ ok: false, error: "not allowed in fake" }));
    }
    return this.reply(body.id, this.tool(name, args));
  }

  private tool(name: string, args: Record<string, unknown>): unknown {
    if (name === "read_status") {
      return toolResult({
        ok: true,
        data: {
          connected: this.tabConnected,
          lastSeenAt: "2026-03-10T08:00:00.000Z",
          linkedin: "Sarah Mendez",
          salesNavigatorSeat: false,
        },
      });
    }
    if (!this.tabConnected) {
      return toolResult({ ok: false, error: "No Kondo tab is connected" });
    }
    if (this.refuse.has(name))
      return toolResult({ ok: false, error: { message: "Kondo is busy" } });
    if (name === "list_inboxes") return toolResult({ ok: true, data: this.labels });
    if (name === "list_inbox") {
      const inbox = String(args.inbox ?? "all");
      const limit = Number(args.limit ?? 20);
      const before = typeof args.before === "number" ? args.before : undefined;
      const after = typeof args.after === "number" ? args.after : undefined;
      const rows = [...this.chats.values()]
        .filter((c) => (inbox === "archive" ? c.archived : !c.archived))
        .map((c) => ({ chat: c, at: activity(c) }))
        .filter(
          (r) => (before === undefined || r.at < before) && (after === undefined || r.at > after),
        )
        .sort((a, b) => b.at - a.at);
      const page = rows.slice(0, limit).map(({ chat, at }) => ({
        profileUrn: chat.profileUrn,
        threadKey: chat.threadKey,
        labelKeys: chat.labelKeys,
        threadParticipantUrns: chat.participants.map((p) => p.profileUrn),
        threadActivityAt: at,
        threadUnreadCount: 0,
        actionStatus: null,
        reminderStatus: null,
        reminderDueAt: null,
        archived: chat.archived,
      }));
      return toolResult(
        { ok: true, data: page },
        rows.length > limit ? ["More results may be available; page with before."] : [],
      );
    }
    if (name === "read_chat") {
      const wanted = (args.chats as Array<{ threadKey: string }> | undefined) ?? [];
      const data = wanted
        .map((w) => this.chats.get(w.threadKey))
        .filter((c): c is FakeChat => c !== undefined)
        .map((c) => ({
          profileUrn: c.profileUrn,
          threadKey: c.threadKey,
          participants: c.participants,
          messages: [...c.messages].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)),
          labelKeys: c.labelKeys,
          chatUrl: `https://app.trykondo.com/inboxes/all/${c.threadKey}`,
        }));
      return toolResult({ ok: true, data }, ["Messages may be incomplete."]);
    }
    return toolResult({ ok: false, error: `unsupported tool ${name}` });
  }

  private reply(
    id: number | undefined,
    result: unknown,
    extra: Record<string, string> = {},
  ): Response {
    const message = { jsonrpc: "2.0", id, result };
    if (this.sse) {
      const body =
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n` +
        `event: message\ndata: ${JSON.stringify(message)}\n\n`;
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream", ...extra },
      });
    }
    return new Response(JSON.stringify(message), {
      status: 200,
      headers: { "content-type": "application/json", ...extra },
    });
  }

  private replyError(id: number | undefined, code: number, message: string): Response {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

function activity(chat: FakeChat): number {
  if (chat.activityAt !== undefined) return chat.activityAt;
  return chat.messages.reduce((max, m) => Math.max(max, Date.parse(m.time)), 0);
}

function toolResult(payload: unknown, hints: string[] = []): unknown {
  return {
    content: [
      { type: "text", text: JSON.stringify(payload) },
      ...hints.map((text) => ({ type: "text", text })),
    ],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function msg(sender: FakeParticipant | "self", time: string, text: string): FakeMessage {
  return sender === "self"
    ? { sender: OWNER.fullName, self: true, time, text }
    : { sender: sender.fullName, self: false, time, text };
}
