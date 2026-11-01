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
  revokeHostAgentGrant,
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
});
