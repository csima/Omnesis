// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { generateKeyPairSync } from "node:crypto";
import Database from "better-sqlite3";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { FictionalAgentHost } from "@omnesis/gateway/src/access/host-identity-test-host.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  authorizeMcpClient,
  portalJson,
  portalRequest,
  type AuthorizedMcpClient,
} from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

const PERSON = "maya.reeves@example.com";
const RESEARCHER = "instance:researcher-1";
const PLANNER = "instance:planner-7";
const STRANGER = "instance:stranger-3";

type MintInput = Parameters<FictionalAgentHost["mint"]>[0];

interface ToolResponse {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

/**
 * An agent host calling one Omnesis connection on behalf of several agents.
 * The host signs in once, as any MCP client does, then attaches its per-call
 * assertion to each `tools/call` and to nothing else, as the real host does.
 */
class HostSession {
  private next: string | null = null;
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;

  constructor(
    gatewayUrl: string,
    authorized: AuthorizedMcpClient,
    private readonly host: FictionalAgentHost,
    private readonly audience: string,
  ) {
    this.transport = new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp`), {
      authProvider: authorized.provider,
      onInsufficientScope: "throw",
      fetch: (url, init) => {
        const assertion = this.next;
        if (assertion && typeof init?.body === "string" && isToolCall(init.body)) {
          this.next = null;
          const headers = new Headers(init.headers);
          headers.set("X-Agent-Host-Identity", assertion);
          return fetch(url, { ...init, headers });
        }
        return fetch(url, init);
      },
    });
    this.client = new Client(
      { name: "fictional-agent-host", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } }, defaultCacheTtlMs: 0 },
    );
  }

  connect(): Promise<void> {
    return this.client.connect(this.transport);
  }

  mint(agents: readonly string[], overrides: Partial<MintInput> = {}): string {
    return this.host.mint({ audience: this.audience, person: PERSON, agents, ...overrides });
  }

  /** One tool call as `agents[0]`, asked by the rest; `assertion` replaces the minted one. */
  call(
    agents: readonly string[] | null,
    name: string,
    args: Record<string, unknown>,
    assertion?: string,
  ): Promise<ToolResponse> {
    this.next = assertion ?? (agents ? this.mint(agents) : null);
    return this.client.callTool({ name, arguments: args }) as Promise<ToolResponse>;
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.client.close(), this.transport.close()]);
  }
}

function isToolCall(body: string): boolean {
  try {
    return (JSON.parse(body) as { method?: unknown }).method === "tools/call";
  } catch {
    return false;
  }
}

describe("Direct MCP through an agent host that says who is calling", () => {
  let harness: SyntheticE2EHarness;
  let host: FictionalAgentHost;
  let authorized: AuthorizedMcpClient;
  let session: HostSession;
  let audience: string;
  let mailSourceId: string;
  let otherSourceId: string;
  let mailDocumentId: string;
  let otherDocumentId: string;
  const grants = new Map<string, string>();

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "default" });
    await harness.start();
    await harness.syncAllSources();
    await harness.refreshSearchSnapshot();
    const known = await harness.gatewayJson<{ results: Array<{ id: string }> }>(
      "/documents/search?q=Globex&limit=1",
    );
    if (!known.results[0]) throw new Error("Synthetic fixture document was not indexed");
    mailDocumentId = known.results[0].id;
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      mailSourceId = db
        .prepare<[string], { source_id: string }>("SELECT source_id FROM documents WHERE id = ?")
        .get(mailDocumentId)!.source_id;
      const other = db
        .prepare<[string], { id: string; source_id: string }>(
          `SELECT id, source_id FROM documents
           WHERE source_id <> ? AND (title LIKE '%Globex%' OR content LIKE '%Globex%')
           ORDER BY source_id, id LIMIT 1`,
        )
        .get(mailSourceId);
      if (!other) throw new Error("The fixture needs Globex documents in two sources");
      otherDocumentId = other.id;
      otherSourceId = other.source_id;
    } finally {
      db.close();
    }

    host = new FictionalAgentHost();
    await host.start();
    audience = `${harness.gatewayUrl}/mcp`;
    authorized = await authorizeMcpClient(
      { gatewayUrl: harness.gatewayUrl, apiKey: harness.apiKey },
      {
        principalName: "Fictional agent host",
        grantName: "Agent host access",
        credentialLabel: "Fictional agent host",
        capabilities: ["direct"],
      },
    );
    await portalJson(
      harness.gatewayUrl,
      authorized.portal,
      `/admin/access/connections/${authorized.principalId}/host-identity`,
      { issuer: host.issuer, audience: `${audience}/` },
      "PUT",
    );
    const mailLevel = await level("Fictional mail reader", [mailSourceId]);
    const bothLevel = await level("Fictional planner reader", [mailSourceId, otherSourceId]);
    grants.set(RESEARCHER, await grant(RESEARCHER, mailLevel));
    grants.set(PLANNER, await grant(PLANNER, bothLevel));

    session = new HostSession(harness.gatewayUrl, authorized, host, audience);
    await session.connect();
  }, 240_000);

  afterAll(async () => {
    await session?.close();
    await Promise.allSettled([authorized?.client.close(), authorized?.transport.close()]);
    await host?.stop();
    await harness?.destroy();
  }, 20_000);

  async function level(name: string, sourceIds: string[]): Promise<string> {
    const created = await portalJson<{ level: { id: string } }>(
      harness.gatewayUrl,
      authorized.portal,
      "/admin/access/levels",
      { name, rules: [{ capability: "direct", sources: { mode: "allowlist", sourceIds } }] },
    );
    return created.level.id;
  }

  async function grant(agent: string, levelId: string, person = PERSON): Promise<string> {
    const created = await portalJson<{ agent: { id: string } }>(
      harness.gatewayUrl,
      authorized.portal,
      `/admin/access/connections/${authorized.principalId}/host-agents`,
      { person, agent, levelId },
    );
    return created.agent.id;
  }

  async function fetchItems(agents: readonly string[], documentId: string) {
    const response = await session.call(agents, "fetch_many", { documents: [{ documentId }] });
    expect(response.isError).not.toBe(true);
    return (response.structuredContent as { items: Array<{ kind: string }> }).items;
  }

  async function searchHits(agents: readonly string[], sourceId: string) {
    const response = await session.call(agents, "search_many", {
      queries: [{ query: "Globex", filters: { sourceIds: [sourceId] }, limit: 10 }],
    });
    expect(response.isError).not.toBe(true);
    const [item] = (response.structuredContent as { items: Array<{ results?: unknown[] }> }).items;
    return JSON.stringify(item?.results ?? []);
  }

  async function coverage(agents: readonly string[]) {
    const response = await session.call(agents, "list_sources", {});
    expect(response.isError).not.toBe(true);
    const sources = (
      response.structuredContent as {
        data: { sources: Array<{ sourceId: string; documentCount: number; coverage: string }> };
      }
    ).data.sources;
    for (const source of sources) expect(source.documentCount).toBeGreaterThan(0);
    return sources.map((source) => source.sourceId).sort();
  }

  /** The reason the gateway gave for refusing one tool call, from its 403 body. */
  async function refusedWith(
    agents: readonly string[] | null,
    assertion?: string,
  ): Promise<string> {
    try {
      await session.call(agents, "list_sources", {}, assertion);
    } catch (error) {
      const match = /"reason":"([a-z-]+)"/u.exec(String(error));
      expect(String(error)).toContain('"code":"host_identity_refused"');
      if (match) return match[1]!;
      throw error;
    }
    throw new Error("The call was not refused.");
  }

  test("lists tools without an assertion but refuses a tool call that carries none", async () => {
    const listed = await session.client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("list_sources");
    const unidentified = await session.call(null, "list_sources", {});
    expect(unidentified.isError).toBe(true);
    expect(unidentified.content?.[0]?.text).toContain("bound to an agent host");
    expect(JSON.stringify(unidentified)).not.toContain(mailSourceId);
  }, 30_000);

  test("gives each host agent its own sources for search, fetch and coverage", async () => {
    expect(await coverage([RESEARCHER])).toEqual([mailSourceId]);
    expect((await fetchItems([RESEARCHER], mailDocumentId))[0]).toMatchObject({ kind: "document" });
    expect((await fetchItems([RESEARCHER], otherDocumentId))[0]).toMatchObject({ kind: "error" });
    expect(await searchHits([RESEARCHER], mailSourceId)).toContain(mailDocumentId);
    expect(await searchHits([RESEARCHER], otherSourceId)).not.toContain(otherDocumentId);

    expect(await coverage([PLANNER])).toEqual([mailSourceId, otherSourceId].sort());
    expect((await fetchItems([PLANNER], otherDocumentId))[0]).toMatchObject({ kind: "document" });
    expect(await searchHits([PLANNER], otherSourceId)).toContain(otherDocumentId);
  }, 60_000);

  test("never lets a delegate reach its delegator's wider grant", async () => {
    expect(await coverage([RESEARCHER, PLANNER])).toEqual([mailSourceId]);
    expect((await fetchItems([RESEARCHER, PLANNER], otherDocumentId))[0]).toMatchObject({
      kind: "error",
    });
    expect(await searchHits([RESEARCHER, PLANNER], otherSourceId)).not.toContain(otherDocumentId);
    expect(await coverage([PLANNER, RESEARCHER])).toEqual([mailSourceId]);
  }, 60_000);

  test("gives an unknown agent, an ungranted delegator and another person nothing", async () => {
    expect(await refusedWith([STRANGER])).toContain("no-grant");
    expect(await refusedWith([PLANNER, STRANGER])).toContain("no-grant");
    expect(
      await refusedWith(null, session.mint([PLANNER], { person: "jamie.lopez@example.com" })),
    ).toContain("no-grant");
  }, 60_000);

  test("refuses a bad signature, another audience or issuer, an expired and a replayed assertion", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(await refusedWith(null, session.mint([PLANNER], { signWith: privateKey }))).toContain(
      "signature",
    );
    expect(
      await refusedWith(
        null,
        session.mint([PLANNER], { audience: "https://other.example.org/mcp" }),
      ),
    ).toContain("audience");
    expect(
      await refusedWith(null, session.mint([PLANNER], { issuer: "https://agents.example.org" })),
    ).toContain("issuer");
    expect(
      await refusedWith(
        null,
        session.mint([PLANNER], { issuedAt: Math.floor(Date.now() / 1_000) - 300 }),
      ),
    ).toContain("expired");
    const once = session.mint([PLANNER]);
    expect(await coverage([PLANNER])).toHaveLength(2);
    const used = await session.call(null, "list_sources", {}, once);
    expect(used.isError).not.toBe(true);
    expect(await refusedWith(null, once)).toContain("replayed");
  }, 60_000);

  test("records the calling agent and its delegators in the access ledger", async () => {
    await coverage([RESEARCHER, PLANNER]);
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const rows = db
        .prepare<[string], { detail: string }>(
          `SELECT detail FROM access_audit_events
            WHERE event_type = 'mcp-tool-invoked' AND principal_id = ?
            ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        )
        .all(authorized.principalId)
        .map((row) => JSON.parse(row.detail) as Record<string, unknown>);
      expect(rows[0]).toMatchObject({
        tool: "list_sources",
        outcome: "ok",
        hostAgent: RESEARCHER,
        hostDelegators: [PLANNER],
        hostAgentGrantIds: [grants.get(RESEARCHER), grants.get(PLANNER)],
      });
    } finally {
      db.close();
    }
  }, 30_000);

  test("applies a revoked grant on the very next call", async () => {
    expect(await coverage([RESEARCHER])).toEqual([mailSourceId]);
    const revoked = await portalRequest(
      harness.gatewayUrl,
      authorized.portal,
      "DELETE",
      `/admin/access/host-agents/${grants.get(RESEARCHER)}`,
    );
    expect(revoked).toMatchObject({ status: 200, body: { revoked: true } });
    expect(await refusedWith([RESEARCHER])).toContain("no-grant");
    expect(await refusedWith([RESEARCHER, PLANNER])).toContain("no-grant");
    expect(await coverage([PLANNER])).toEqual([mailSourceId, otherSourceId].sort());

    const listed = await portalJson<{
      bindings: Array<{ connectionId: string; agents: Array<{ agent: string }> }>;
    }>(harness.gatewayUrl, authorized.portal, "/admin/access/host-identity");
    expect(listed.bindings).toEqual([
      expect.objectContaining({
        connectionId: authorized.principalId,
        agents: [expect.objectContaining({ agent: PLANNER })],
      }),
    ]);
  }, 60_000);
});
