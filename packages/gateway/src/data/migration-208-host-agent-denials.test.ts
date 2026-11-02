// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createHostAgentGrantTables } from "./migration-206-host-agent-grants.js";
import { allowHostAgentDenials } from "./migration-208-host-agent-denials.js";
import type { Db } from "./types.js";

let db: Database.Database;

const LIVE = "00000000-0000-4000-8000-0000000000a1";
const REMOVED = "00000000-0000-4000-8000-0000000000a2";
const UNGRANTED = "00000000-0000-4000-8000-0000000000a3";
const LEVEL = "00000000-0000-4000-8000-0000000000b1";

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE access_principals (id TEXT PRIMARY KEY, revoked_at INTEGER);
    CREATE TABLE access_levels (id TEXT PRIMARY KEY, revoked_at INTEGER);
    CREATE TABLE access_grants (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, revoked_at INTEGER);
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
  const hostGrant = db.prepare(
    `INSERT INTO access_host_agent_grants (id, principal_id, person, agent, level_id, created_at, revoked_at)
     VALUES (?, ?, 'maya@example.com', ?, ?, 1, ?)`,
  );
  for (const [principalId, prefix] of [
    [LIVE, "live"],
    [REMOVED, "removed"],
    [UNGRANTED, "ungranted"],
  ] as const) {
    bind.run(principalId);
    hostGrant.run(`${prefix}-agent`, principalId, "instance:agent-a", LEVEL, null);
    hostGrant.run(`${prefix}-default`, principalId, "*", LEVEL, null);
  }
  hostGrant.run("live-old", LIVE, "instance:agent-b", LEVEL, 3);
});
afterEach(() => db.close());

function levelRequired(): number | undefined {
  return db
    .prepare<[], { name: string; notnull: number }>(
      "SELECT name, \"notnull\" FROM pragma_table_info('access_host_agent_grants')",
    )
    .all()
    .find((column) => column.name === "level_id")?.notnull;
}

it("lets a host agent grant name no level, keeping every row and index", () => {
  expect(levelRequired()).toBe(1);
  db.transaction(() => allowHostAgentDenials(db as unknown as Db, 100))();
  expect(levelRequired()).toBe(0);
  expect(
    db
      .prepare("SELECT id FROM access_host_agent_grants ORDER BY id")
      .all()
      .map((row) => (row as { id: string }).id),
  ).toEqual([
    "live-agent",
    "live-default",
    "live-old",
    "removed-agent",
    "removed-default",
    "ungranted-agent",
    "ungranted-default",
  ]);
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

it("releases the host access of a connection removed before removal released it", () => {
  db.transaction(() => allowHostAgentDenials(db as unknown as Db, 100))();
  expect(
    db.prepare("SELECT id, revoked_at FROM access_host_agent_grants ORDER BY id").all(),
  ).toEqual([
    { id: "live-agent", revoked_at: null },
    { id: "live-default", revoked_at: null },
    { id: "live-old", revoked_at: 3 },
    { id: "removed-agent", revoked_at: 100 },
    { id: "removed-default", revoked_at: 100 },
    { id: "ungranted-agent", revoked_at: 100 },
    { id: "ungranted-default", revoked_at: 100 },
  ]);
  expect(db.prepare("SELECT principal_id FROM access_host_identity_bindings").all()).toEqual([
    { principal_id: LIVE },
  ]);
});

it("is idempotent", () => {
  allowHostAgentDenials(db as unknown as Db, 100);
  allowHostAgentDenials(db as unknown as Db, 200);
  expect(levelRequired()).toBe(0);
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM access_host_agent_grants WHERE revoked_at = 200").get(),
  ).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM access_host_agent_grants").get()).toEqual({ n: 7 });
});
