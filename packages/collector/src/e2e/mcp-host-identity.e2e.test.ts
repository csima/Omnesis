// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { generateKeyPairSync, randomUUID } from "node:crypto";
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
const ANSWERER = "instance:answerer-a";
const SECOND_ANSWERER = "instance:answerer-b";
const SECOND_PERSON = "jamie.lopez@example.com";
const AGENT_A = "instance:agent-a";
const AGENT_B = "instance:agent-b";
const RUN_WORKER = "instance:run-0042";
const QUESTION = "When is the Halden Press order due to arrive?";

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

describe("MCP through an agent host that says who is calling", () => {
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
  let mailLevel: string;
  let bothLevel: string;
  let answerLevel: string;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "default",
      agentBackend: "replay",
      extraInference: { assignments: { "privacy-reviewer": "replay" } },
    });
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
        capabilities: ["direct", "answer"],
        rules: [
          { capability: "direct", sources: { mode: "all", sourceIds: [] } },
          {
            capability: "answer",
            sources: { mode: "all", sourceIds: [] },
            release: { mode: "unreviewed" },
          },
        ],
      },
    );
    await portalJson(
      harness.gatewayUrl,
      authorized.portal,
      `/admin/access/connections/${authorized.principalId}/host-identity`,
      { issuer: host.issuer, audience: `${audience}/` },
      "PUT",
    );
    mailLevel = await level("Fictional mail reader", [mailSourceId]);
    bothLevel = await level("Fictional planner reader", [mailSourceId, otherSourceId]);
    grants.set(RESEARCHER, await grant(RESEARCHER, mailLevel));
    grants.set(PLANNER, await grant(PLANNER, bothLevel));
    answerLevel = (
      await portalJson<{ level: { id: string } }>(
        harness.gatewayUrl,
        authorized.portal,
        "/admin/access/levels",
        {
          name: "Fictional answer desk",
          rules: [
            {
              capability: "answer",
              sources: { mode: "all", sourceIds: [] },
              release: { mode: "unreviewed" },
            },
          ],
        },
      )
    ).level.id;
    await grant(ANSWERER, answerLevel);
    await grant(SECOND_ANSWERER, answerLevel);
    await grant(ANSWERER, answerLevel, SECOND_PERSON);

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

  async function setDefault(levelId: string, person = PERSON) {
    return portalJson<{ default: { id: string; levelId: string } }>(
      harness.gatewayUrl,
      authorized.portal,
      `/admin/access/connections/${authorized.principalId}/host-agent-default`,
      { person, levelId },
      "PUT",
    );
  }

  async function clearDefault(person = PERSON) {
    return portalRequest(
      harness.gatewayUrl,
      authorized.portal,
      "DELETE",
      `/admin/access/connections/${authorized.principalId}/host-agent-default?person=${encodeURIComponent(person)}`,
    );
  }

  function lastInvocation(): Record<string, unknown> {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const row = db
        .prepare<[string], { detail: string }>(
          `SELECT detail FROM access_audit_events
            WHERE event_type = 'mcp-tool-invoked' AND principal_id = ?
            ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        )
        .get(authorized.principalId);
      if (!row) throw new Error("No tool call was recorded");
      return JSON.parse(row.detail) as Record<string, unknown>;
    } finally {
      db.close();
    }
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

  test("keeps each host agent's Answer tasks and conversations its own", async () => {
    const requestId = `host_answer_${randomUUID()}`;
    const asked = await session.call([ANSWERER], "ask_omnesis", {
      question: QUESTION,
      requestId,
      workflowName: "Fictional delivery desk",
      workflowPurpose: "Return delivery status for open orders.",
    });
    expect(asked.isError).not.toBe(true);
    const released = asked.structuredContent as {
      status: string;
      taskId: string;
      conversationId: string;
      answer: string;
    };
    expect(released.status).toBe("released");
    const status = await session.call([ANSWERER], "get_answer_status", {
      taskId: released.taskId,
    });
    expect(status.structuredContent).toMatchObject({ taskId: released.taskId });

    const foreignStatus = await session.call([SECOND_ANSWERER], "get_answer_status", {
      taskId: released.taskId,
    });
    expect(foreignStatus.isError).toBe(true);
    expect(JSON.stringify(foreignStatus)).not.toContain(released.answer);

    const foreignContinuation = await session.call([SECOND_ANSWERER], "ask_omnesis", {
      question: "And who is the courier?",
      requestId: `host_answer_${randomUUID()}`,
      conversationId: released.conversationId,
    });
    expect(foreignContinuation.isError).toBe(true);
    expect(JSON.stringify(foreignContinuation)).not.toContain(released.answer);

    const collision = await session.call([SECOND_ANSWERER], "ask_omnesis", {
      question: QUESTION,
      requestId,
      workflowName: "Fictional delivery desk",
      workflowPurpose: "Return delivery status for open orders.",
    });
    expect(collision.isError).not.toBe(true);
    expect((collision.structuredContent as { taskId: string }).taskId).not.toBe(released.taskId);

    const otherPerson = await session.call(
      null,
      "get_answer_status",
      { taskId: released.taskId },
      session.mint([ANSWERER], { person: SECOND_PERSON }),
    );
    expect(otherPerson.isError).toBe(true);
    expect(JSON.stringify(otherPerson)).not.toContain(released.answer);
  }, 180_000);

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
    expect(listed.bindings).toHaveLength(1);
    expect(listed.bindings[0]?.connectionId).toBe(authorized.principalId);
    expect(listed.bindings[0]?.agents.map((entry) => entry.agent).sort()).toEqual(
      [ANSWERER, ANSWERER, SECOND_ANSWERER, PLANNER].sort(),
    );
  }, 60_000);

  test("gives an agent no grant names the person's default, while a grant naming one wins", async () => {
    expect(await refusedWith([AGENT_A])).toContain("no-grant");
    const set = await setDefault(mailLevel);
    expect(set.default.levelId).toBe(mailLevel);
    expect(await coverage([AGENT_A])).toEqual([mailSourceId]);
    expect(await coverage([RUN_WORKER])).toEqual([mailSourceId]);
    expect((await fetchItems([AGENT_A], otherDocumentId))[0]).toMatchObject({ kind: "error" });
    expect(await coverage([PLANNER])).toEqual([mailSourceId, otherSourceId].sort());

    await setDefault(bothLevel);
    await grant(AGENT_B, mailLevel);
    expect(await coverage([AGENT_B])).toEqual([mailSourceId]);
    expect(await coverage([AGENT_A])).toEqual([mailSourceId, otherSourceId].sort());
    expect(await coverage([AGENT_A, AGENT_B])).toEqual([mailSourceId]);

    const listed = await portalJson<{
      bindings: Array<{ agents: Array<{ agent: string }>; defaults: Array<{ person: string }> }>;
    }>(harness.gatewayUrl, authorized.portal, "/admin/access/host-identity");
    expect(listed.bindings[0]?.defaults).toEqual([
      expect.objectContaining({ person: PERSON, levelId: bothLevel }),
    ]);
    expect(listed.bindings[0]?.agents.map((entry) => entry.agent)).not.toContain("*");
  }, 90_000);

  test("records in the access ledger that the default gave the level", async () => {
    expect(await coverage([RUN_WORKER, PLANNER])).toEqual([mailSourceId, otherSourceId].sort());
    expect(lastInvocation()).toMatchObject({
      tool: "list_sources",
      outcome: "ok",
      hostAgent: RUN_WORKER,
      hostDelegators: [PLANNER],
      hostAgentGrants: [
        { agent: RUN_WORKER, grant: "default" },
        { agent: PLANNER, grant: "exact" },
      ],
    });
    expect(await coverage([AGENT_B])).toEqual([mailSourceId]);
    expect(lastInvocation()).toMatchObject({
      hostAgentGrants: [{ agent: AGENT_B, grant: "exact" }],
    });
  }, 60_000);

  test("refuses another person, issuer or audience and an expired assertion despite the default", async () => {
    expect(await refusedWith(null, session.mint([AGENT_A], { person: SECOND_PERSON }))).toContain(
      "no-grant",
    );
    expect(
      await refusedWith(null, session.mint([AGENT_A], { issuer: "https://agents.example.org" })),
    ).toContain("issuer");
    expect(
      await refusedWith(
        null,
        session.mint([AGENT_A], { audience: "https://other.example.org/mcp" }),
      ),
    ).toContain("audience");
    expect(
      await refusedWith(
        null,
        session.mint([AGENT_A], { issuedAt: Math.floor(Date.now() / 1_000) - 300 }),
      ),
    ).toContain("expired");
  }, 60_000);

  test("lets an answer-only default ask Omnesis but read nothing directly", async () => {
    await setDefault(answerLevel);
    const direct = await session.call([AGENT_A], "list_sources", {}).catch((error: unknown) => ({
      isError: true,
      content: [{ type: "text", text: String(error) }],
    }));
    expect(direct.isError).toBe(true);
    expect(JSON.stringify(direct)).not.toContain(mailSourceId);
    const asked = await session.call([RUN_WORKER], "ask_omnesis", {
      question: QUESTION,
      requestId: `host_answer_${randomUUID()}`,
      workflowName: "Fictional delivery desk",
      workflowPurpose: "Return delivery status for open orders.",
    });
    expect(asked.isError).not.toBe(true);
    expect((asked.structuredContent as { status: string }).status).toBe("released");
  }, 180_000);

  test("refuses the person's other agents again on the very next call once it is cleared", async () => {
    expect(await clearDefault()).toMatchObject({ status: 200, body: { cleared: true } });
    expect(await refusedWith([AGENT_A])).toContain("no-grant");
    expect(await refusedWith([RUN_WORKER])).toContain("no-grant");
    expect(await refusedWith([PLANNER, AGENT_A])).toContain("no-grant");
    expect(await coverage([AGENT_B])).toEqual([mailSourceId]);
    expect(await clearDefault()).toMatchObject({ status: 404 });
  }, 60_000);

  test("never widens a removed agent to the default unasked, and denies an agent by name", async () => {
    await setDefault(bothLevel);
    const narrow = await grant("instance:agent-c", mailLevel);
    expect(await coverage(["instance:agent-c"])).toEqual([mailSourceId]);
    const refused = await portalRequest(
      harness.gatewayUrl,
      authorized.portal,
      "DELETE",
      `/admin/access/host-agents/${narrow}`,
    );
    expect(refused).toMatchObject({ status: 409, body: { error: "default-would-apply" } });
    expect(await coverage(["instance:agent-c"])).toEqual([mailSourceId]);
    const meant = await portalRequest(
      harness.gatewayUrl,
      authorized.portal,
      "DELETE",
      `/admin/access/host-agents/${narrow}?fallback=default`,
    );
    expect(meant).toMatchObject({ status: 200, body: { revoked: true } });
    expect(await coverage(["instance:agent-c"])).toEqual([mailSourceId, otherSourceId].sort());

    const denied = await portalJson<{ agent: { agent: string; levelId: string | null } }>(
      harness.gatewayUrl,
      authorized.portal,
      `/admin/access/connections/${authorized.principalId}/host-agents`,
      { person: PERSON, agent: "instance:agent-c", levelId: null },
      "PUT",
    );
    expect(denied.agent).toMatchObject({ agent: "instance:agent-c", levelId: null });
    expect(await refusedWith(["instance:agent-c"])).toBe("denied");
    expect(await refusedWith([AGENT_A, "instance:agent-c"])).toBe("denied");
    expect(await coverage([AGENT_A])).toEqual([mailSourceId, otherSourceId].sort());

    await grant("instance:Agent-D", mailLevel);
    expect(await coverage(["instance:agent-d"])).toEqual([mailSourceId]);
    expect(await refusedWith(["instance:Agent-D"])).toBe("malformed");
    expect(await refusedWith(["instance:agent_d"])).toBe("malformed");
    expect(await refusedWith([AGENT_A, "instance:Agent-D"])).toBe("malformed");

    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const denial = db
        .prepare<[string], { detail: string }>(
          `SELECT detail FROM access_audit_events
            WHERE event_type = 'host-agent-denied' AND principal_id = ?
            ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        )
        .get(authorized.principalId);
      expect(JSON.parse(denial!.detail)).toMatchObject({
        person: PERSON,
        agent: "instance:agent-c",
        levelId: null,
      });
    } finally {
      db.close();
    }
  }, 90_000);

  test("takes the host access with it when the connection is removed", async () => {
    expect(await coverage([AGENT_A])).toEqual([mailSourceId, otherSourceId].sort());
    await portalJson(harness.gatewayUrl, authorized.portal, "/portal/api/access/revoke", {
      kind: "principal",
      id: authorized.principalId,
    });
    const listed = await portalJson<{ bindings: unknown[] }>(
      harness.gatewayUrl,
      authorized.portal,
      "/admin/access/host-identity",
    );
    expect(listed.bindings).toEqual([]);
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      expect(
        db
          .prepare<[string], { live: number }>(
            `SELECT COUNT(*) AS live FROM access_host_agent_grants
              WHERE principal_id = ? AND revoked_at IS NULL`,
          )
          .get(authorized.principalId)?.live,
      ).toBe(0);
      expect(
        db
          .prepare<[string], { bound: number }>(
            "SELECT COUNT(*) AS bound FROM access_host_identity_bindings WHERE principal_id = ?",
          )
          .get(authorized.principalId)?.bound,
      ).toBe(0);
    } finally {
      db.close();
    }
  }, 60_000);
});
