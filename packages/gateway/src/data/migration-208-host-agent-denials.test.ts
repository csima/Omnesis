// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAccessLevel,
  defaultAuthorizationScope,
  setHostIdentityBinding,
} from "../access/store.js";
import { authorizeInteractiveAccess } from "../access/test-utils.js";
import { createDatabase } from "../db.js";
import { createHostAgentGrantTables } from "./migration-206-host-agent-grants.js";
import { allowHostAgentDenials } from "./migration-208-host-agent-denials.js";
import { LATEST_SCHEMA_VERSION } from "./migrations.js";
import type { Db } from "./types.js";

const LIVE = "00000000-0000-4000-8000-0000000000a1";
const REMOVED = "00000000-0000-4000-8000-0000000000a2";
const UNGRANTED = "00000000-0000-4000-8000-0000000000a3";
const LEVEL = "00000000-0000-4000-8000-0000000000b1";

function levelRequired(db: Database.Database | Db): number | undefined {
  return (db as Database.Database)
    .prepare<[], { name: string; notnull: number }>(
      "SELECT name, \"notnull\" FROM pragma_table_info('access_host_agent_grants')",
    )
    .all()
    .find((column) => column.name === "level_id")?.notnull;
}

function auditEvents(db: Database.Database | Db, prefix: string) {
  return (db as Database.Database)
    .prepare<[string], { event_type: string; principal_id: string; detail: string }>(
      `SELECT event_type, principal_id, detail FROM access_audit_events
        WHERE event_type LIKE ? ORDER BY occurred_at, rowid`,
    )
    .all(`${prefix}%`)
    .map((row) => ({
      type: row.event_type,
      principalId: row.principal_id,
      detail: JSON.parse(row.detail) as Record<string, unknown>,
    }));
}

describe("migration 208 on the bare schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE access_principals (id TEXT PRIMARY KEY, revoked_at INTEGER);
      CREATE TABLE access_levels (id TEXT PRIMARY KEY, revoked_at INTEGER);
      CREATE TABLE access_grants (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, revoked_at INTEGER);
      CREATE TABLE access_audit_events (
        id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, event_type TEXT NOT NULL,
        principal_id TEXT, grant_id TEXT, grant_revision INTEGER, credential_id TEXT,
        oauth_client_id TEXT, actor_token_id TEXT, detail TEXT NOT NULL DEFAULT '{}'
      );
    `);
    // The host tables as migration 206 created them: every grant names a level.
    createHostAgentGrantTables(db as unknown as Db);
    db.prepare("INSERT INTO access_levels (id) VALUES (?)").run(LEVEL);
    const principal = db.prepare("INSERT INTO access_principals (id, revoked_at) VALUES (?, ?)");
    principal.run(LIVE, null);
    principal.run(REMOVED, 5);
    principal.run(UNGRANTED, null);
    const grant = db.prepare(
      "INSERT INTO access_grants (id, principal_id, revoked_at) VALUES (?, ?, ?)",
    );
    grant.run("grant-live", LIVE, null);
    grant.run("grant-removed", REMOVED, null);
    grant.run("grant-ungranted", UNGRANTED, 7);
    const bind = db.prepare(
      `INSERT INTO access_host_identity_bindings (principal_id, issuer, audience, created_at, updated_at)
       VALUES (?, 'https://agents.example.com', 'https://omnesis.example.com/mcp', 1, 1)`,
    );
    for (const [principalId, prefix] of [
      [LIVE, "live"],
      [REMOVED, "removed"],
      [UNGRANTED, "ungranted"],
    ] as const) {
      bind.run(principalId);
      plant(`${prefix}-agent`, principalId, "instance:agent-a");
      plant(`${prefix}-default`, principalId, "*");
    }
    plant("live-old", LIVE, "instance:agent-b", 3);
  });
  afterEach(() => db.close());

  function plant(id: string, principalId: string, agent: string, revokedAt: number | null = null) {
    db.prepare(
      `INSERT INTO access_host_agent_grants (id, principal_id, person, agent, level_id, created_at, revoked_at)
       VALUES (?, ?, 'maya@example.com', ?, ?, 1, ?)`,
    ).run(id, principalId, agent, LEVEL, revokedAt);
  }

  function rows() {
    return db
      .prepare("SELECT id, agent, revoked_at FROM access_host_agent_grants ORDER BY id")
      .all();
  }

  it("lets a host agent grant name no level, keeping every row and index", () => {
    expect(levelRequired(db)).toBe(1);
    db.transaction(() => allowHostAgentDenials(db as unknown as Db, 100))();
    expect(levelRequired(db)).toBe(0);
    expect(rows()).toHaveLength(7);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'access_host_agent_grants' AND name LIKE 'idx_%' ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "idx_access_host_agent_grants_level" },
      { name: "idx_access_host_agent_grants_live" },
    ]);
    db.prepare(
      `INSERT INTO access_host_agent_grants (id, principal_id, person, agent, level_id, created_at)
       VALUES ('live-denial', ?, 'maya@example.com', 'instance:agent-c', NULL, 2)`,
    ).run(LIVE);
    expect(() =>
      db
        .prepare(
          `INSERT INTO access_host_agent_grants (id, principal_id, person, agent, level_id, created_at)
           VALUES ('live-twice', ?, 'maya@example.com', 'instance:agent-a', NULL, 2)`,
        )
        .run(LIVE),
    ).toThrow(/UNIQUE/u);
  });

  it("releases, with an audit row each, the host access of connections removed before", () => {
    db.transaction(() => allowHostAgentDenials(db as unknown as Db, 100))();
    expect(rows()).toEqual([
      { id: "live-agent", agent: "instance:agent-a", revoked_at: null },
      { id: "live-default", agent: "*", revoked_at: null },
      { id: "live-old", agent: "instance:agent-b", revoked_at: 3 },
      { id: "removed-agent", agent: "instance:agent-a", revoked_at: 100 },
      { id: "removed-default", agent: "*", revoked_at: 100 },
      { id: "ungranted-agent", agent: "instance:agent-a", revoked_at: 100 },
      { id: "ungranted-default", agent: "*", revoked_at: 100 },
    ]);
    expect(db.prepare("SELECT principal_id FROM access_host_identity_bindings").all()).toEqual([
      { principal_id: LIVE },
    ]);
    expect(auditEvents(db, "host-identity-unbound")).toEqual([
      {
        type: "host-identity-unbound",
        principalId: REMOVED,
        detail: { reason: "connection-removed" },
      },
      {
        type: "host-identity-unbound",
        principalId: UNGRANTED,
        detail: { reason: "connection-removed" },
      },
    ]);
  });

  it("renames a mis-cased agent it can, and revokes the rest, auditing each", () => {
    plant("live-legacy", LIVE, "instance:Agent-Legacy");
    plant("live-dup", LIVE, "instance:Agent-A");
    plant("live-underscore", LIVE, "instance:agent_c");
    plant("live-fold-1", LIVE, "instance:Agent-Twin");
    plant("live-fold-2", LIVE, "instance:AGENT-TWIN");
    plant("removed-legacy", REMOVED, "instance:Agent-Gone");
    db.transaction(() => allowHostAgentDenials(db as unknown as Db, 100))();
    const live = db
      .prepare(
        `SELECT id, agent FROM access_host_agent_grants
          WHERE principal_id = ? AND revoked_at IS NULL ORDER BY id`,
      )
      .all(LIVE);
    expect(live).toEqual([
      { id: "live-agent", agent: "instance:agent-a" },
      { id: "live-default", agent: "*" },
      { id: "live-fold-1", agent: "instance:agent-twin" },
      { id: "live-legacy", agent: "instance:agent-legacy" },
    ]);
    expect(auditEvents(db, "host-agent-").map((event) => [event.type, event.detail])).toEqual([
      [
        "host-agent-revoked",
        {
          hostAgentGrantId: "live-dup",
          person: "maya@example.com",
          agent: "instance:Agent-A",
          levelId: LEVEL,
          reason: "invalid-agent-name",
        },
      ],
      [
        "host-agent-renamed",
        {
          hostAgentGrantId: "live-fold-1",
          person: "maya@example.com",
          from: "instance:Agent-Twin",
          agent: "instance:agent-twin",
          levelId: LEVEL,
        },
      ],
      [
        "host-agent-revoked",
        expect.objectContaining({ hostAgentGrantId: "live-fold-2", reason: "invalid-agent-name" }),
      ],
      [
        "host-agent-renamed",
        expect.objectContaining({
          hostAgentGrantId: "live-legacy",
          agent: "instance:agent-legacy",
        }),
      ],
      [
        "host-agent-revoked",
        expect.objectContaining({ hostAgentGrantId: "live-underscore", agent: "instance:agent_c" }),
      ],
    ]);
  });

  it("is idempotent", () => {
    plant("live-legacy", LIVE, "instance:Agent-Legacy");
    allowHostAgentDenials(db as unknown as Db, 100);
    const audited = auditEvents(db, "").length;
    allowHostAgentDenials(db as unknown as Db, 200);
    expect(levelRequired(db)).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM access_host_agent_grants WHERE revoked_at = 200").get(),
    ).toEqual({ n: 0 });
    expect(auditEvents(db, "")).toHaveLength(audited);
  });
});

describe("migration 208 replayed over a pre-208 install", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-mig-208-"));
    dbPath = join(dir, `omnesis-${randomUUID()}.db`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("upgrades host agent grants through the real open path", () => {
    const old = createDatabase(dbPath);
    const level = createAccessLevel(old, {
      name: "Fictional reader",
      rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
      actorTokenId: "portal-token",
    });
    if (!level.ok) throw new Error(level.error);
    const connection = (name: string) =>
      authorizeInteractiveAccess(old, {
        selection: {
          kind: "new-connection",
          name,
          level: { kind: "existing", levelId: level.value.id, expectedLevelRevision: 1 },
        },
        resource: "https://omnesis.example.org/mcp",
        scope: defaultAuthorizationScope(),
      }).principalId;
    const live = connection("Fictional agent host");
    const removed = connection("Second fictional host");
    for (const principalId of [live, removed]) {
      const bound = setHostIdentityBinding(old, {
        connectionId: principalId,
        issuer: "https://agents.example.com",
        audience: "https://omnesis.example.org/mcp",
        actorTokenId: "portal-token",
      });
      if (!bound.ok) throw new Error(bound.error);
    }
    // Shape the table as 206 left it, then plant what an install held then.
    old.exec("DROP TABLE access_host_agent_grants");
    createHostAgentGrantTables(old);
    expect(levelRequired(old)).toBe(1);
    const plant = old.prepare(
      `INSERT INTO access_host_agent_grants (id, principal_id, person, agent, level_id, created_at)
       VALUES (?, ?, 'maya@example.com', ?, ?, 1)`,
    );
    plant.run("grant-legacy", live, "instance:Agent-Legacy", level.value.id);
    plant.run("grant-current", live, "instance:agent-a", level.value.id);
    plant.run("grant-default", live, "*", level.value.id);
    plant.run("grant-removed", removed, "instance:agent-b", level.value.id);
    old.prepare("UPDATE access_principals SET revoked_at = 5 WHERE id = ?").run(removed);
    old.exec("DELETE FROM schema_migrations WHERE version > 207; PRAGMA user_version = 207");
    old.close();

    const upgraded = createDatabase(dbPath);
    try {
      expect(upgraded.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      expect(levelRequired(upgraded)).toBe(0);
      expect(
        upgraded
          .prepare(
            "SELECT id, agent, revoked_at IS NOT NULL AS revoked FROM access_host_agent_grants ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "grant-current", agent: "instance:agent-a", revoked: 0 },
        { id: "grant-default", agent: "*", revoked: 0 },
        { id: "grant-legacy", agent: "instance:agent-legacy", revoked: 0 },
        { id: "grant-removed", agent: "instance:agent-b", revoked: 1 },
      ]);
      expect(
        upgraded.prepare("SELECT principal_id FROM access_host_identity_bindings").all(),
      ).toEqual([{ principal_id: live }]);
      expect(
        auditEvents(upgraded, "host-").map((event) => [event.type, event.principalId]),
      ).toEqual(
        expect.arrayContaining([
          ["host-identity-unbound", removed],
          ["host-agent-renamed", live],
        ]),
      );
      upgraded
        .prepare(
          `INSERT INTO access_host_agent_grants (id, principal_id, person, agent, level_id, created_at)
           VALUES ('grant-denied', ?, 'maya@example.com', 'instance:agent-c', NULL, 2)`,
        )
        .run(live);
    } finally {
      upgraded.close();
    }
  });
});
