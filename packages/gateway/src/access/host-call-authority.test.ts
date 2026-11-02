// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSchemaSetup } from "../data/schema.js";
import { commitPrivacyPolicy } from "../privacy/policy-history.js";
import { HostCallAuthorizer, intersectCapabilities } from "./host-call-authority.js";
import { HostIdentityVerifier } from "./host-identity.js";
import { FictionalAgentHost } from "./host-identity-test-host.js";
import {
  createAccessLevel,
  createHostAgentGrant,
  defaultAuthorizationScope,
  deleteAccessLevel,
  listHostIdentity,
  lookupPrincipalAccessToken,
  recordMcpToolInvocationAudit,
  removeHostIdentityBinding,
  revokeAccessEntity,
  revokeHostAgentGrant,
  setHostAgentDefault,
  setHostAgentGrant,
  setHostIdentityBinding,
  updateAccessLevel,
} from "./store.js";
import { authorizeInteractiveAccess } from "./test-utils.js";
import type { Db } from "../data/types.js";
import type {
  AccessGrantCapability,
  AccessGrantRuleInput,
  McpToolInvocationAuditInput,
} from "./types.js";

const RESOURCE = "https://omnesis.example.org/mcp";
const ACTOR = "portal-token";
const PERSON = "maya.reeves@example.com";
const RESEARCHER = "instance:researcher-1";
const PLANNER = "instance:planner-7";
const SOURCES = ["mail:alpha", "notes:beta", "files:gamma"];

function rule(
  capability: AccessGrantCapability["capability"],
  sourceMode: AccessGrantCapability["sourceMode"],
  sourceIds: string[] = [],
  release: Partial<AccessGrantCapability> = {},
): AccessGrantCapability {
  return {
    capability,
    sourceMode,
    sourceIds,
    releaseMode: capability === "answer" ? "unreviewed" : null,
    policyFamilyId: null,
    policyRevision: null,
    privacyPolicy: null,
    ...release,
  };
}

describe("intersectCapabilities", () => {
  it("keeps a capability only where every set has it, over the sources every set allows", () => {
    expect(
      intersectCapabilities([
        [rule("direct", "all"), rule("notes", "all")],
        [rule("direct", "allowlist", ["mail:alpha", "notes:beta"])],
        [rule("direct", "denylist", ["notes:beta"]), rule("notes", "all")],
      ]),
    ).toEqual([rule("direct", "allowlist", ["mail:alpha"])]);
  });

  it("unions denylists and intersects allowlists", () => {
    expect(
      intersectCapabilities([
        [rule("direct", "denylist", ["mail:alpha"])],
        [rule("direct", "denylist", ["files:gamma"])],
      ]),
    ).toEqual([rule("direct", "denylist", ["files:gamma", "mail:alpha"])]);
    expect(
      intersectCapabilities([
        [rule("direct", "allowlist", ["mail:alpha"])],
        [rule("direct", "allowlist", ["notes:beta"])],
      ]),
    ).toEqual([]);
  });

  it("releases Answer under the stricter mode, and not at all under two policies", () => {
    const reviewed = {
      releaseMode: "reviewed" as const,
      policyFamilyId: "family-one",
      policyRevision: "revision-one",
      privacyPolicy: "Family one",
    };
    expect(
      intersectCapabilities([[rule("answer", "all")], [rule("answer", "all", [], reviewed)]]),
    ).toEqual([rule("answer", "all", [], reviewed)]);
    expect(
      intersectCapabilities([
        [rule("answer", "all", [], reviewed)],
        [rule("answer", "all", [], { ...reviewed, policyFamilyId: "family-two" })],
      ]),
    ).toEqual([]);
  });
});

describe("HostCallAuthorizer", () => {
  let db: Db;
  let host: FictionalAgentHost;
  let authorizer: HostCallAuthorizer;
  let connectionId: string;
  let connectionCapabilities: AccessGrantCapability[];
  let accessTokenId: string;
  let grantId: string;
  let credentialId: string;
  let clientId: string;
  let mailLevel: string;
  let wideLevel: string;

  beforeEach(async () => {
    db = new Database(":memory:") as unknown as Db;
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
    commitPrivacyPolicy(db, {
      policy: "# Test policy\n\nAllow fictional summaries.\n",
      digest: "a".repeat(64),
      revision: "b".repeat(64),
      expectedRevision: null,
      action: "bootstrap",
      revertedFromGeneration: null,
      createdAt: Date.now() - 1,
    });
    db.prepare(
      "INSERT INTO devices (id, name, kind, paired_at) VALUES ('00000000-0000-4000-8000-000000000001', 'Fictional desktop', 'desktop', 1)",
    ).run();
    for (const id of SOURCES) {
      db.prepare(
        `INSERT INTO sources (id, type, account_id, device_id, created_at, updated_at)
         VALUES (?, ?, ?, '00000000-0000-4000-8000-000000000001', 1, 1)`,
      ).run(id, id.split(":")[0], id.split(":")[1]);
    }
    host = new FictionalAgentHost();
    await host.start();
    authorizer = new HostCallAuthorizer(db, new HostIdentityVerifier());

    const connectionLevel = level("Agent host", [
      { capability: "direct", sources: { mode: "all", sourceIds: [] } },
      { capability: "notes", sources: { mode: "all", sourceIds: [] } },
    ]);
    mailLevel = level("Mail reader", [
      { capability: "direct", sources: { mode: "allowlist", sourceIds: ["mail:alpha"] } },
    ]);
    wideLevel = level("Mail and notes reader", [
      {
        capability: "direct",
        sources: { mode: "allowlist", sourceIds: ["mail:alpha", "notes:beta"] },
      },
      { capability: "notes", sources: { mode: "all", sourceIds: [] } },
    ]);
    const connection = authorizeInteractiveAccess(db, {
      selection: {
        kind: "new-connection",
        name: "Fictional agent host",
        level: { kind: "existing", levelId: connectionLevel, expectedLevelRevision: 1 },
      },
      resource: RESOURCE,
      scope: defaultAuthorizationScope(),
    });
    const token = lookupPrincipalAccessToken(db, connection.tokens.accessToken, RESOURCE);
    if (!token) throw new Error("the fixture connection has no live token");
    connectionId = connection.principalId;
    connectionCapabilities = token.capabilities;
    accessTokenId = token.accessTokenId;
    grantId = connection.grantId;
    credentialId = connection.credentialId;
    clientId = connection.clientId;
  });

  afterEach(async () => {
    await host.stop();
    db.close();
  });

  function level(name: string, rules: AccessGrantRuleInput[]): string {
    const created = createAccessLevel(db, { name, rules, actorTokenId: ACTOR });
    if (!created.ok) throw new Error(`level not created: ${created.error}`);
    return created.value.id;
  }

  function bind(): void {
    const bound = setHostIdentityBinding(db, {
      connectionId,
      issuer: host.issuer,
      audience: `${RESOURCE}/`,
      actorTokenId: ACTOR,
    });
    if (!bound.ok) throw new Error(`binding failed: ${bound.error}`);
  }

  function grant(agent: string, levelId: string, person = PERSON): string {
    const created = createHostAgentGrant(db, {
      connectionId,
      person,
      agent,
      levelId,
      actorTokenId: ACTOR,
    });
    if (!created.ok) throw new Error(`grant failed: ${created.error}`);
    return created.value.id;
  }

  function call(agents: string[], person = PERSON) {
    return authorizer.authorize({
      connectionId,
      connectionCapabilities,
      assertion: host.mint({ audience: RESOURCE, person, agents }),
    });
  }

  function audit(
    overrides: Partial<McpToolInvocationAuditInput> = {},
  ): McpToolInvocationAuditInput {
    return {
      accessTokenId,
      principalId: connectionId,
      grantId,
      grantRevision: 1,
      credentialId,
      oauthClientId: clientId,
      capability: "direct",
      tool: "search_many",
      outcome: "ok",
      requestId: "request-1",
      sourceMode: "allowlist",
      requireActiveAuthority: true,
      ...overrides,
    };
  }

  it("leaves an ordinary connection alone", async () => {
    await expect(
      authorizer.authorize({ connectionId, connectionCapabilities, assertion: "ignored" }),
    ).resolves.toEqual({ kind: "unbound" });
  });

  it("lets a bound connection list tools without an assertion but marks it unidentified", async () => {
    bind();
    await expect(
      authorizer.authorize({ connectionId, connectionCapabilities, assertion: undefined }),
    ).resolves.toEqual({ kind: "unidentified" });
  });

  it("gives each agent its own level cut from the connection's grant", async () => {
    bind();
    grant(RESEARCHER, mailLevel);
    grant(PLANNER, wideLevel);
    const researcher = await call([RESEARCHER]);
    expect(researcher).toMatchObject({
      kind: "authorized",
      capabilities: [rule("direct", "allowlist", ["mail:alpha"])],
      audit: { agent: RESEARCHER, delegators: [] },
    });
    const planner = await call([PLANNER]);
    expect(planner).toMatchObject({
      kind: "authorized",
      capabilities: [
        rule("direct", "allowlist", ["mail:alpha", "notes:beta"]),
        rule("notes", "all"),
      ],
    });
  });

  it("never lets a delegate reach its delegator's wider grant", async () => {
    bind();
    grant(RESEARCHER, mailLevel);
    grant(PLANNER, wideLevel);
    await expect(call([RESEARCHER, PLANNER])).resolves.toMatchObject({
      kind: "authorized",
      capabilities: [rule("direct", "allowlist", ["mail:alpha"])],
      audit: { agent: RESEARCHER, delegators: [PLANNER] },
    });
    await expect(call([PLANNER, RESEARCHER])).resolves.toMatchObject({
      kind: "authorized",
      capabilities: [rule("direct", "allowlist", ["mail:alpha"])],
    });
  });

  it("gives an unknown agent, an ungranted delegator or another person nothing", async () => {
    bind();
    grant(PLANNER, wideLevel);
    await expect(call(["instance:stranger-3"])).resolves.toEqual({
      kind: "refused",
      reason: "no-grant",
    });
    await expect(call([PLANNER, "instance:stranger-3"])).resolves.toEqual({
      kind: "refused",
      reason: "no-grant",
    });
    await expect(call([PLANNER], "jamie.lopez@example.com")).resolves.toEqual({
      kind: "refused",
      reason: "no-grant",
    });
  });

  it("refuses a failed assertion by its reason", async () => {
    bind();
    grant(RESEARCHER, mailLevel);
    await expect(
      authorizer.authorize({
        connectionId,
        connectionCapabilities,
        assertion: host.mint({
          audience: "https://other.example.org/mcp",
          person: PERSON,
          agents: [RESEARCHER],
        }),
      }),
    ).resolves.toEqual({ kind: "refused", reason: "audience" });
  });

  it("applies a revocation and a level edit on the next call", async () => {
    bind();
    const researcherGrant = grant(RESEARCHER, mailLevel);
    grant(PLANNER, wideLevel);
    expect((await call([PLANNER])).kind).toBe("authorized");
    const edited = updateAccessLevel(db, {
      levelId: wideLevel,
      expectedRevision: 1,
      rules: [{ capability: "direct", sources: { mode: "allowlist", sourceIds: ["notes:beta"] } }],
      actorTokenId: ACTOR,
    });
    expect(edited.ok).toBe(true);
    await expect(call([PLANNER])).resolves.toMatchObject({
      capabilities: [rule("direct", "allowlist", ["notes:beta"])],
    });
    expect(revokeHostAgentGrant(db, { grantId: researcherGrant, actorTokenId: ACTOR }).ok).toBe(
      true,
    );
    await expect(call([RESEARCHER])).resolves.toEqual({ kind: "refused", reason: "no-grant" });
  });

  it("fences a call's grants at egress", async () => {
    bind();
    const researcherGrant = grant(RESEARCHER, mailLevel);
    const authorized = await call([RESEARCHER]);
    if (authorized.kind !== "authorized") throw new Error("expected an authorized caller");
    expect(recordMcpToolInvocationAudit(db, audit({ hostCaller: authorized.audit }))).toBe(true);
    expect(recordMcpToolInvocationAudit(db, audit())).toBe(false);
    revokeHostAgentGrant(db, { grantId: researcherGrant, actorTokenId: ACTOR });
    expect(recordMcpToolInvocationAudit(db, audit({ hostCaller: authorized.audit }))).toBe(false);

    grant(PLANNER, wideLevel);
    const planner = await call([PLANNER]);
    if (planner.kind !== "authorized") throw new Error("expected an authorized caller");
    expect(recordMcpToolInvocationAudit(db, audit({ hostCaller: planner.audit }))).toBe(true);
    updateAccessLevel(db, {
      levelId: wideLevel,
      expectedRevision: 1,
      rules: [{ capability: "direct", sources: { mode: "allowlist", sourceIds: ["notes:beta"] } }],
      actorTokenId: ACTOR,
    });
    expect(recordMcpToolInvocationAudit(db, audit({ hostCaller: planner.audit }))).toBe(false);
  });

  it("keeps an in-use level and revokes every grant when the host changes or is unbound", () => {
    bind();
    grant(RESEARCHER, mailLevel);
    expect(deleteAccessLevel(db, { levelId: mailLevel, actorTokenId: ACTOR })).toEqual({
      ok: false,
      error: "level-in-use",
    });
    expect(
      createHostAgentGrant(db, {
        connectionId,
        person: PERSON.toUpperCase(),
        agent: RESEARCHER,
        levelId: wideLevel,
        actorTokenId: ACTOR,
      }),
    ).toEqual({ ok: false, error: "host-agent-exists" });
    expect(listHostIdentity(db).bindings[0]).toMatchObject({
      connectionId,
      issuer: host.issuer,
      audience: RESOURCE,
      agents: [{ agent: RESEARCHER, person: PERSON, levelName: "Mail reader" }],
    });

    expect(
      setHostIdentityBinding(db, {
        connectionId,
        issuer: "https://agents.example.org",
        audience: RESOURCE,
        actorTokenId: ACTOR,
      }).ok,
    ).toBe(true);
    expect(listHostIdentity(db).bindings[0]?.agents).toEqual([]);

    grant(RESEARCHER, mailLevel);
    expect(removeHostIdentityBinding(db, { connectionId, actorTokenId: ACTOR }).ok).toBe(true);
    expect(listHostIdentity(db).bindings).toEqual([]);
    expect(deleteAccessLevel(db, { levelId: mailLevel, actorTokenId: ACTOR }).ok).toBe(true);
  });

  it("refuses an invalid host, agent or unbound connection", () => {
    expect(
      setHostIdentityBinding(db, {
        connectionId,
        issuer: "http://agents.example.org",
        audience: RESOURCE,
        actorTokenId: ACTOR,
      }),
    ).toEqual({ ok: false, error: "invalid-selection" });
    expect(
      createHostAgentGrant(db, {
        connectionId,
        person: PERSON,
        agent: RESEARCHER,
        levelId: mailLevel,
        actorTokenId: ACTOR,
      }),
    ).toEqual({ ok: false, error: "host-not-bound" });
    bind();
    expect(
      createHostAgentGrant(db, {
        connectionId,
        person: PERSON,
        agent: "all",
        levelId: mailLevel,
        actorTokenId: ACTOR,
      }),
    ).toEqual({ ok: false, error: "invalid-selection" });
  });

  describe("a person's default level for agents no grant names", () => {
    const AGENT_A = "instance:agent-a";
    const RUN_WORKER = "instance:run-0042";

    function setDefault(levelId: string | null, person = PERSON, connection = connectionId) {
      return setHostAgentDefault(db, {
        connectionId: connection,
        person,
        levelId,
        actorTokenId: ACTOR,
      });
    }

    function defaultOn(levelId: string, person = PERSON, connection = connectionId): string {
      const set = setDefault(levelId, person, connection);
      if (!set.ok || !set.value) throw new Error("the default was not set");
      return set.value.id;
    }

    function lastInvocationDetail(): Record<string, unknown> {
      const row = db
        .prepare<[string], { detail: string }>(
          `SELECT detail FROM access_audit_events
            WHERE event_type = 'mcp-tool-invoked' AND principal_id = ?
            ORDER BY occurred_at DESC, rowid DESC LIMIT 1`,
        )
        .get(connectionId);
      if (!row) throw new Error("no invocation was recorded");
      return JSON.parse(row.detail) as Record<string, unknown>;
    }

    function secondConnection(): { id: string; capabilities: AccessGrantCapability[] } {
      const connection = authorizeInteractiveAccess(db, {
        selection: {
          kind: "new-connection",
          name: "Second fictional agent host",
          level: {
            kind: "existing",
            levelId: level("Second host", [
              { capability: "direct", sources: { mode: "all", sourceIds: [] } },
            ]),
            expectedLevelRevision: 1,
          },
        },
        resource: RESOURCE,
        scope: defaultAuthorizationScope(),
      });
      const token = lookupPrincipalAccessToken(db, connection.tokens.accessToken, RESOURCE);
      if (!token) throw new Error("the second connection has no live token");
      const bound = setHostIdentityBinding(db, {
        connectionId: connection.principalId,
        issuer: host.issuer,
        audience: RESOURCE,
        actorTokenId: ACTOR,
      });
      if (!bound.ok) throw new Error(`binding failed: ${bound.error}`);
      return { id: connection.principalId, capabilities: token.capabilities };
    }

    it("gives an agent no grant names the person's default", async () => {
      bind();
      const defaultId = defaultOn(mailLevel);
      for (const agent of [AGENT_A, RUN_WORKER]) {
        await expect(call([agent])).resolves.toMatchObject({
          kind: "authorized",
          capabilities: [rule("direct", "allowlist", ["mail:alpha"])],
          audit: {
            agent,
            grants: [{ agent, grant: "default", grantId: defaultId, levelId: mailLevel }],
          },
        });
      }
    });

    it("refuses an unlisted agent when the person has no default", async () => {
      bind();
      grant(PLANNER, wideLevel);
      await expect(call([AGENT_A])).resolves.toEqual({ kind: "refused", reason: "no-grant" });
    });

    it("lets a grant naming the agent win, lower or higher, still capped by the connection", async () => {
      bind();
      const answerAndMail = level("Answer and mail", [
        { capability: "direct", sources: { mode: "allowlist", sourceIds: ["mail:alpha"] } },
        {
          capability: "answer",
          sources: { mode: "all", sourceIds: [] },
          release: { mode: "unreviewed" },
        },
      ]);
      defaultOn(wideLevel);
      grant(RESEARCHER, mailLevel);
      grant(PLANNER, answerAndMail);
      await expect(call([RESEARCHER])).resolves.toMatchObject({
        kind: "authorized",
        capabilities: [rule("direct", "allowlist", ["mail:alpha"])],
        audit: { grants: [{ agent: RESEARCHER, grant: "exact" }] },
      });
      await expect(call([PLANNER])).resolves.toMatchObject({
        capabilities: [rule("direct", "allowlist", ["mail:alpha"])],
        audit: { grants: [{ agent: PLANNER, grant: "exact" }] },
      });
      await expect(call([AGENT_A])).resolves.toMatchObject({
        capabilities: [
          rule("direct", "allowlist", ["mail:alpha", "notes:beta"]),
          rule("notes", "all"),
        ],
      });

      defaultOn(answerAndMail);
      grant(AGENT_A, wideLevel);
      await expect(call([AGENT_A])).resolves.toMatchObject({
        capabilities: [
          rule("direct", "allowlist", ["mail:alpha", "notes:beta"]),
          rule("notes", "all"),
        ],
        audit: { grants: [{ agent: AGENT_A, grant: "exact" }] },
      });
      const capped = await call([RUN_WORKER]);
      expect(capped).toMatchObject({
        kind: "authorized",
        capabilities: [rule("direct", "allowlist", ["mail:alpha"])],
      });
      if (capped.kind !== "authorized") throw new Error("expected an authorized caller");
      expect(capped.capabilities.map((entry) => entry.capability)).not.toContain("answer");
    });

    it("cuts a delegated call by each agent's grant or default", async () => {
      bind();
      defaultOn(mailLevel);
      grant(PLANNER, wideLevel);
      await expect(call([AGENT_A, PLANNER])).resolves.toMatchObject({
        capabilities: [rule("direct", "allowlist", ["mail:alpha"])],
        audit: {
          grants: [
            { agent: AGENT_A, grant: "default" },
            { agent: PLANNER, grant: "exact" },
          ],
        },
      });
      await expect(call([PLANNER, AGENT_A])).resolves.toMatchObject({
        capabilities: [rule("direct", "allowlist", ["mail:alpha"])],
      });
    });

    it("refuses unlisted agents again once the default is cleared", async () => {
      bind();
      defaultOn(mailLevel);
      expect((await call([AGENT_A])).kind).toBe("authorized");
      expect(setDefault(null)).toEqual({ ok: true, value: null });
      await expect(call([AGENT_A])).resolves.toEqual({ kind: "refused", reason: "no-grant" });
      expect(setDefault(null)).toEqual({ ok: false, error: "not-found" });
    });

    it("refuses another person, issuer or audience and an expired assertion despite a default", async () => {
      bind();
      defaultOn(mailLevel);
      const mint = (overrides: Partial<Parameters<FictionalAgentHost["mint"]>[0]>) =>
        authorizer.authorize({
          connectionId,
          connectionCapabilities,
          assertion: host.mint({
            audience: RESOURCE,
            person: PERSON,
            agents: [AGENT_A],
            ...overrides,
          }),
        });
      await expect(mint({ person: "jamie.lopez@example.com" })).resolves.toEqual({
        kind: "refused",
        reason: "no-grant",
      });
      await expect(mint({ issuer: "https://agents.example.org" })).resolves.toEqual({
        kind: "refused",
        reason: "issuer",
      });
      await expect(mint({ audience: "https://other.example.org/mcp" })).resolves.toEqual({
        kind: "refused",
        reason: "audience",
      });
      await expect(mint({ issuedAt: Math.floor(Date.now() / 1_000) - 300 })).resolves.toEqual({
        kind: "refused",
        reason: "expired",
      });
      expect((await mint({})).kind).toBe("authorized");
    });

    it("keeps a default to its own person and its own binding", async () => {
      bind();
      defaultOn(mailLevel, "jamie.lopez@example.com");
      await expect(call([AGENT_A])).resolves.toEqual({ kind: "refused", reason: "no-grant" });
      expect((await call([AGENT_A], "jamie.lopez@example.com")).kind).toBe("authorized");

      defaultOn(mailLevel);
      const second = secondConnection();
      const through = (connection: { id: string; capabilities: AccessGrantCapability[] }) =>
        authorizer.authorize({
          connectionId: connection.id,
          connectionCapabilities: connection.capabilities,
          assertion: host.mint({ audience: RESOURCE, person: PERSON, agents: [AGENT_A] }),
        });
      await expect(through(second)).resolves.toEqual({ kind: "refused", reason: "no-grant" });
      defaultOn(wideLevel, PERSON, second.id);
      expect(setDefault(null)).toEqual({ ok: true, value: null });
      await expect(call([AGENT_A])).resolves.toEqual({ kind: "refused", reason: "no-grant" });
      expect((await through(second)).kind).toBe("authorized");
    });

    it("records in the ledger that a call's level came from the default", async () => {
      bind();
      const defaultId = defaultOn(mailLevel);
      const plannerGrant = grant(PLANNER, wideLevel);
      const authorized = await call([AGENT_A, PLANNER]);
      if (authorized.kind !== "authorized") throw new Error("expected an authorized caller");
      expect(recordMcpToolInvocationAudit(db, audit({ hostCaller: authorized.audit }))).toBe(true);
      expect(lastInvocationDetail()).toMatchObject({
        hostAgent: AGENT_A,
        hostDelegators: [PLANNER],
        hostAgentGrantIds: [defaultId, plannerGrant],
        hostAgentGrants: [
          { agent: AGENT_A, grant: "default" },
          { agent: PLANNER, grant: "exact" },
        ],
      });
    });

    it("fences a defaulted call when the default changes or a grant names the agent", async () => {
      bind();
      defaultOn(mailLevel);
      const first = await call([AGENT_A]);
      if (first.kind !== "authorized") throw new Error("expected an authorized caller");
      expect(recordMcpToolInvocationAudit(db, audit({ hostCaller: first.audit }))).toBe(true);
      grant(AGENT_A, wideLevel);
      expect(recordMcpToolInvocationAudit(db, audit({ hostCaller: first.audit }))).toBe(false);

      const second = await call([RUN_WORKER]);
      if (second.kind !== "authorized") throw new Error("expected an authorized caller");
      expect(recordMcpToolInvocationAudit(db, audit({ hostCaller: second.audit }))).toBe(true);
      defaultOn(wideLevel);
      expect(recordMcpToolInvocationAudit(db, audit({ hostCaller: second.audit }))).toBe(false);

      const third = await call([RUN_WORKER]);
      if (third.kind !== "authorized") throw new Error("expected an authorized caller");
      setDefault(null);
      expect(recordMcpToolInvocationAudit(db, audit({ hostCaller: third.audit }))).toBe(false);

      defaultOn(wideLevel);
      const fourth = await call([RUN_WORKER]);
      if (fourth.kind !== "authorized") throw new Error("expected an authorized caller");
      const claimedExact = {
        ...fourth.audit,
        grants: fourth.audit.grants.map((entry) => ({ ...entry, grant: "exact" as const })),
      };
      expect(recordMcpToolInvocationAudit(db, audit({ hostCaller: claimedExact }))).toBe(false);
      expect(recordMcpToolInvocationAudit(db, audit({ hostCaller: fourth.audit }))).toBe(true);
    });

    it("never falls back to the default for an agent whose own grant's level is gone", async () => {
      bind();
      defaultOn(wideLevel);
      grant(RESEARCHER, mailLevel);
      db.prepare("UPDATE access_levels SET revoked_at = ? WHERE id = ?").run(Date.now(), mailLevel);
      await expect(call([RESEARCHER])).resolves.toEqual({ kind: "refused", reason: "no-grant" });
      expect((await call([AGENT_A])).kind).toBe("authorized");
    });

    it("lists defaults apart from agents and revokes them with the binding", () => {
      expect(setDefault(mailLevel)).toEqual({ ok: false, error: "host-not-bound" });
      bind();
      expect(setDefault(mailLevel, "not a person")).toEqual({
        ok: false,
        error: "invalid-selection",
      });
      expect(setDefault("00000000-0000-4000-8000-00000000ffff")).toEqual({
        ok: false,
        error: "inactive-grant",
      });
      grant(RESEARCHER, mailLevel);
      const id = defaultOn(wideLevel, PERSON.toUpperCase());
      expect(defaultOn(wideLevel)).toBe(id);
      expect(listHostIdentity(db).bindings[0]).toMatchObject({
        agents: [{ agent: RESEARCHER }],
        defaults: [{ id, person: PERSON, levelId: wideLevel, levelName: "Mail and notes reader" }],
      });
      expect(listHostIdentity(db).bindings[0]?.agents).toHaveLength(1);
      expect(deleteAccessLevel(db, { levelId: wideLevel, actorTokenId: ACTOR })).toEqual({
        ok: false,
        error: "level-in-use",
      });
      expect(
        createHostAgentGrant(db, {
          connectionId,
          person: PERSON,
          agent: "*",
          levelId: wideLevel,
          actorTokenId: ACTOR,
        }),
      ).toEqual({ ok: false, error: "invalid-selection" });

      expect(
        setHostIdentityBinding(db, {
          connectionId,
          issuer: "https://agents.example.org",
          audience: RESOURCE,
          actorTokenId: ACTOR,
        }).ok,
      ).toBe(true);
      expect(listHostIdentity(db).bindings[0]?.defaults).toEqual([]);
      defaultOn(wideLevel);
      expect(removeHostIdentityBinding(db, { connectionId, actorTokenId: ACTOR }).ok).toBe(true);
      expect(deleteAccessLevel(db, { levelId: wideLevel, actorTokenId: ACTOR }).ok).toBe(true);
    });

    function events(prefix: string): Array<{ type: string; detail: Record<string, unknown> }> {
      return db
        .prepare<[string], { event_type: string; detail: string | null }>(
          `SELECT event_type, detail FROM access_audit_events
            WHERE event_type LIKE ? ORDER BY occurred_at, rowid`,
        )
        .all(`${prefix}%`)
        .map((row) => ({
          type: row.event_type,
          detail: JSON.parse(row.detail ?? "{}") as Record<string, unknown>,
        }));
    }

    function deny(agent: string, person = PERSON): string {
      const created = createHostAgentGrant(db, {
        connectionId,
        person,
        agent,
        levelId: null,
        actorTokenId: ACTOR,
      });
      if (!created.ok) throw new Error(`deny failed: ${created.error}`);
      return created.value.id;
    }

    function fenced(authority: Awaited<ReturnType<typeof call>>): boolean {
      if (authority.kind !== "authorized") throw new Error("expected an authorized caller");
      return recordMcpToolInvocationAudit(db, audit({ hostCaller: authority.audit }));
    }

    it("refuses to widen an agent to the default when its grant is revoked, unless asked to", async () => {
      bind();
      const fallback = defaultOn(wideLevel);
      const narrow = grant(RESEARCHER, mailLevel);
      expect(revokeHostAgentGrant(db, { grantId: narrow, actorTokenId: ACTOR })).toEqual({
        ok: false,
        error: "default-would-apply",
      });
      await expect(call([RESEARCHER])).resolves.toMatchObject({
        capabilities: [rule("direct", "allowlist", ["mail:alpha"])],
        audit: { grants: [{ grant: "exact", grantId: narrow }] },
      });
      expect(
        revokeHostAgentGrant(db, { grantId: narrow, actorTokenId: ACTOR, fallback: "default" }),
      ).toEqual({ ok: true, value: null });
      await expect(call([RESEARCHER])).resolves.toMatchObject({
        capabilities: [
          rule("direct", "allowlist", ["mail:alpha", "notes:beta"]),
          rule("notes", "all"),
        ],
        audit: { grants: [{ grant: "default", grantId: fallback }] },
      });
      expect(events("host-agent-revoked").at(-1)?.detail).toMatchObject({
        hostAgentGrantId: narrow,
        person: PERSON,
        agent: RESEARCHER,
        fallbackHostAgentGrantId: fallback,
      });

      setDefault(null);
      const unwidened = grant(PLANNER, mailLevel);
      expect(revokeHostAgentGrant(db, { grantId: unwidened, actorTokenId: ACTOR }).ok).toBe(true);
    });

    it("denies one agent by name, over the default and in any chain, and audits the denial", async () => {
      bind();
      defaultOn(wideLevel);
      const denial = deny(RESEARCHER);
      await expect(call([RESEARCHER])).resolves.toEqual({ kind: "refused", reason: "denied" });
      await expect(call([AGENT_A, RESEARCHER])).resolves.toEqual({
        kind: "refused",
        reason: "denied",
      });
      expect((await call([AGENT_A])).kind).toBe("authorized");
      expect(events("host-agent-denied")).toEqual([
        {
          type: "host-agent-denied",
          detail: { hostAgentGrantId: denial, person: PERSON, agent: RESEARCHER, levelId: null },
        },
      ]);
      expect(listHostIdentity(db).bindings[0]?.agents).toEqual([
        expect.objectContaining({ id: denial, agent: RESEARCHER, levelId: null, levelName: null }),
      ]);

      const replaced = setHostAgentGrant(db, {
        connectionId,
        person: PERSON,
        agent: RESEARCHER,
        levelId: mailLevel,
        actorTokenId: ACTOR,
      });
      expect(replaced).toMatchObject({
        ok: true,
        value: { agent: RESEARCHER, levelId: mailLevel },
      });
      await expect(call([RESEARCHER])).resolves.toMatchObject({
        capabilities: [rule("direct", "allowlist", ["mail:alpha"])],
      });
      expect(events("host-agent-granted").at(-1)?.detail).toMatchObject({
        replacedHostAgentGrantId: denial,
        levelId: mailLevel,
      });
      setHostAgentGrant(db, {
        connectionId,
        person: PERSON,
        agent: RESEARCHER,
        levelId: null,
        actorTokenId: ACTOR,
      });
      await expect(call([RESEARCHER])).resolves.toEqual({ kind: "refused", reason: "denied" });
    });

    it("fences a defaulted call once its agent is denied", async () => {
      bind();
      defaultOn(wideLevel);
      const running = await call([AGENT_A]);
      expect(fenced(running)).toBe(true);
      deny(AGENT_A);
      expect(fenced(running)).toBe(false);
    });

    it("names a grant's agent in lower case and refuses a name the host cannot send", async () => {
      bind();
      defaultOn(wideLevel);
      const mixed = createHostAgentGrant(db, {
        connectionId,
        person: PERSON,
        agent: " instance:Researcher-1 ",
        levelId: mailLevel,
        actorTokenId: ACTOR,
      });
      expect(mixed).toMatchObject({ ok: true, value: { agent: RESEARCHER } });
      await expect(call([RESEARCHER])).resolves.toMatchObject({
        capabilities: [rule("direct", "allowlist", ["mail:alpha"])],
        audit: { grants: [{ grant: "exact" }] },
      });
      for (const agent of [
        "*",
        " * ",
        "*\n",
        "instance:*",
        "instance:agent-a*",
        "instance:1-agent",
        "instance:a",
        "instance:agent.a",
        "instance:agent_a",
        `instance:a${"b".repeat(41)}`,
        "agent-a",
      ]) {
        expect(
          createHostAgentGrant(db, {
            connectionId,
            person: PERSON,
            agent,
            levelId: mailLevel,
            actorTokenId: ACTOR,
          }),
        ).toEqual({ ok: false, error: "invalid-selection" });
      }
    });

    it("refuses an agent a grant names only in other letter case instead of giving it the default", async () => {
      bind();
      defaultOn(wideLevel);
      db.prepare(
        `INSERT INTO access_host_agent_grants (id, principal_id, person, agent, level_id, created_at)
         VALUES ('00000000-0000-4000-8000-0000000000c1', ?, ?, 'instance:Researcher-1', ?, 1)`,
      ).run(connectionId, PERSON, mailLevel);
      await expect(call([RESEARCHER])).resolves.toEqual({
        kind: "refused",
        reason: "agent-name-mismatch",
      });
      grant(PLANNER, mailLevel);
      await expect(call(["instance:Planner-7"])).resolves.toEqual({
        kind: "refused",
        reason: "agent-name-mismatch",
      });

      const running = await call([AGENT_A]);
      expect(fenced(running)).toBe(true);
      db.prepare(
        `INSERT INTO access_host_agent_grants (id, principal_id, person, agent, level_id, created_at)
         VALUES ('00000000-0000-4000-8000-0000000000c2', ?, ?, 'instance:AGENT-A', ?, 1)`,
      ).run(connectionId, PERSON, mailLevel);
      expect(fenced(running)).toBe(false);
    });

    it("never lets a default, a grant or the clear route touch the other's rows", async () => {
      bind();
      const fallback = defaultOn(wideLevel);
      expect(revokeHostAgentGrant(db, { grantId: fallback, actorTokenId: ACTOR })).toEqual({
        ok: false,
        error: "not-found",
      });
      expect(
        revokeHostAgentGrant(db, { grantId: fallback, actorTokenId: ACTOR, fallback: "default" }),
      ).toEqual({ ok: false, error: "not-found" });
      expect((await call([AGENT_A])).kind).toBe("authorized");
      expect(events("host-agent-revoked")).toEqual([]);
    });

    it("releases host access when the connection is removed, defaults included", async () => {
      bind();
      const fallback = defaultOn(wideLevel);
      grant(RESEARCHER, mailLevel);
      const running = await call([AGENT_A]);
      expect(
        revokeAccessEntity(db, { kind: "principal", id: connectionId, actorTokenId: ACTOR }),
      ).toBe(true);
      expect(
        db
          .prepare<[string], { live: number }>(
            "SELECT COUNT(*) AS live FROM access_host_agent_grants WHERE principal_id = ? AND revoked_at IS NULL",
          )
          .get(connectionId)?.live,
      ).toBe(0);
      expect(listHostIdentity(db).bindings).toEqual([]);
      expect(fenced(running)).toBe(false);
      expect(deleteAccessLevel(db, { levelId: wideLevel, actorTokenId: ACTOR }).ok).toBe(true);
      expect(events("host-identity-unbound").at(-1)?.detail).toEqual({
        reason: "connection-removed",
      });
      expect(fallback).toBeTruthy();
    });

    it("releases host access when the connection's last grant is revoked", () => {
      bind();
      defaultOn(wideLevel);
      expect(revokeAccessEntity(db, { kind: "grant", id: grantId, actorTokenId: ACTOR })).toBe(
        true,
      );
      expect(
        db
          .prepare<[string], { bound: number }>(
            "SELECT COUNT(*) AS bound FROM access_host_identity_bindings WHERE principal_id = ?",
          )
          .get(connectionId)?.bound,
      ).toBe(0);
      expect(setDefault(null)).toEqual({ ok: false, error: "not-found" });
    });

    it("hides and still clears a default left on a connection removed before it was released", () => {
      bind();
      defaultOn(wideLevel);
      db.prepare("UPDATE access_principals SET revoked_at = 1 WHERE id = ?").run(connectionId);
      expect(listHostIdentity(db).bindings).toEqual([]);
      expect(setDefault(wideLevel)).toEqual({ ok: false, error: "not-found" });
      expect(setDefault(null)).toEqual({ ok: true, value: null });
      expect(deleteAccessLevel(db, { levelId: wideLevel, actorTokenId: ACTOR }).ok).toBe(true);
    });

    it("names the person in the audit of a default set, replaced and cleared", () => {
      bind();
      const first = defaultOn(mailLevel);
      const second = defaultOn(wideLevel);
      setDefault(null);
      expect(events("host-agent-default")).toEqual([
        {
          type: "host-agent-default-set",
          detail: { hostAgentGrantId: first, person: PERSON, levelId: mailLevel },
        },
        {
          type: "host-agent-default-set",
          detail: {
            hostAgentGrantId: second,
            person: PERSON,
            levelId: wideLevel,
            replacedHostAgentGrantId: first,
          },
        },
        {
          type: "host-agent-default-cleared",
          detail: { hostAgentGrantId: second, person: PERSON, levelId: wideLevel },
        },
      ]);
    });

    it("sets a default only for an email address", () => {
      bind();
      for (const person of [
        "*",
        "maya",
        "maya@",
        "@example.com",
        "maya@example",
        "a b@example.com",
      ]) {
        expect(setDefault(mailLevel, person)).toEqual({ ok: false, error: "invalid-selection" });
      }
      expect(setDefault(mailLevel, "Maya.Reeves+agents@Example.com")).toMatchObject({
        ok: true,
        value: { person: "maya.reeves+agents@example.com" },
      });
    });

    it("never lets an actor that only looks like an agent reach the default", async () => {
      bind();
      defaultOn(wideLevel);
      const raw = (claims: Record<string, unknown>) =>
        authorizer.authorize({
          connectionId,
          connectionCapabilities,
          assertion: host.mint({ audience: RESOURCE, person: PERSON, agents: [], claims }),
        });
      for (const act of [
        { sub: "*" },
        { sub: "instance:*" },
        { sub: " instance:agent-a" },
        { sub: "instance:agent-a\n" },
        { sub: "INSTANCE:agent-a" },
        { sub: "instance\uff1aagent-a" },
        { sub: "instance:agent\u2010a" },
        { sub: "instance:" },
        [{ sub: AGENT_A }],
        { sub: AGENT_A, act: { sub: "*" } },
        { sub: AGENT_A, act: "instance:agent-b" },
        {},
        undefined,
      ]) {
        await expect(raw({ act })).resolves.toEqual({ kind: "refused", reason: "malformed" });
      }
      for (const sub of [
        "maya.reeves@example.com\u200b",
        "maya.reeves@ex\u0430mple.com",
        "",
        42,
        null,
      ]) {
        await expect(raw({ sub, act: { sub: AGENT_A } })).resolves.toEqual({
          kind: "refused",
          reason: "malformed",
        });
      }
      expect((await raw({ sub: ` ${PERSON.toUpperCase()} `, act: { sub: AGENT_A } })).kind).toBe(
        "authorized",
      );
      await expect(raw({ sub: "*", act: { sub: AGENT_A } })).resolves.toEqual({
        kind: "refused",
        reason: "no-grant",
      });
    });

    it("keeps a running default call through unrelated grants, but not through a new default", async () => {
      bind();
      defaultOn(wideLevel);
      const running = await call([AGENT_A]);
      const other = grant(AGENT_A, mailLevel, "jamie.lopez@example.com");
      expect(fenced(running)).toBe(true);
      revokeHostAgentGrant(db, { grantId: other, actorTokenId: ACTOR });
      setDefault(null);
      defaultOn(wideLevel);
      expect(fenced(running)).toBe(false);
    });
  });
});
