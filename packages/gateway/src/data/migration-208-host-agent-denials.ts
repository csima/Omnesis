// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";

import type { Db } from "./types.js";

/** An agent as a grant names it, and as the agent host mints it. */
const GRANT_AGENT_PATTERN = /^instance:[a-z][a-z0-9-]{1,40}$/u;
const HOST_AGENT_DEFAULT = "*";

interface LiveAgentRow {
  id: string;
  principal_id: string;
  person: string;
  agent: string;
  level_id: string | null;
}

/**
 * Host agents that are denied by name, agent names only as the host mints
 * them, and no host access left behind a removed connection.
 *
 * A row of `access_host_agent_grants` whose `level_id` is null denies that
 * agent any access, even where the person's default would admit it. Migration
 * 206 made `level_id` required, so the table is rebuilt with it nullable; no
 * other table references it, so the rebuild runs inside the runner's
 * transaction and keeps every row and id.
 *
 * An agent is now named only as `instance:` and a lower-case id the host
 * mints, and an assertion naming it any other way is refused. A live grant
 * named another way could never match a call again, but it would sit beside
 * the agent's real grant, so each one is settled here, simplest first:
 *
 * - its lower-case form is a valid name no live grant of that person has: it
 *   is renamed to that form, keeping the level the operator gave it;
 * - otherwise it is revoked, since a valid grant for that name already wins
 *   or no call can carry the name at all.
 *
 * A connection that was removed before host access followed it out still has
 * its binding and live agent grants. They are revoked and the binding dropped,
 * as removing the connection now does.
 *
 * Removed connections are released first, so only live access is renamed.
 * When two grants of one person fold to the same name, the older keeps it and
 * the later is revoked.
 *
 * Each rename, revocation and release appends the `access_audit_events` row
 * the access store writes for it. The rows are composed here, on the bare
 * schema, rather than through the live access code.
 *
 * Idempotent: the rebuild runs only while `level_id` is still required, and a
 * settled or released row has nothing left to settle. Installed on fresh
 * databases by `createAccessTables` after migration 206's tables.
 */
export function allowHostAgentDenials(db: Db, now = Date.now()): void {
  if (!hasTable(db, "access_host_agent_grants")) return;
  relaxLevelColumn(db);
  const audit = auditWriter(db, now);
  releaseRemovedConnections(db, now, audit);
  settleAgentNames(db, now, audit);
}

function hasTable(db: Db, name: string): boolean {
  return (
    db
      .prepare<[string], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== undefined
  );
}

function relaxLevelColumn(db: Db): void {
  const levelColumn = db
    .prepare<[], { name: string; notnull: number }>(
      "SELECT name, \"notnull\" FROM pragma_table_info('access_host_agent_grants')",
    )
    .all()
    .find((column) => column.name === "level_id");
  if (levelColumn?.notnull !== 1) return;
  db.exec(`
    CREATE TABLE access_host_agent_grants_208 (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES access_principals(id) ON DELETE CASCADE,
      person TEXT NOT NULL,
      agent TEXT NOT NULL,
      level_id TEXT REFERENCES access_levels(id),
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    INSERT INTO access_host_agent_grants_208
      (id, principal_id, person, agent, level_id, created_at, revoked_at)
      SELECT id, principal_id, person, agent, level_id, created_at, revoked_at
        FROM access_host_agent_grants;
    DROP TABLE access_host_agent_grants;
    ALTER TABLE access_host_agent_grants_208 RENAME TO access_host_agent_grants;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_access_host_agent_grants_live
      ON access_host_agent_grants(principal_id, person, agent) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_access_host_agent_grants_level
      ON access_host_agent_grants(level_id) WHERE revoked_at IS NULL;
  `);
}

type AuditWriter = (eventType: string, principalId: string, detail: object) => void;

function auditWriter(db: Db, now: number): AuditWriter {
  if (!hasTable(db, "access_audit_events")) return () => {};
  const insert = db.prepare<[string, number, string, string, string]>(
    `INSERT INTO access_audit_events (id, occurred_at, event_type, principal_id, detail)
     VALUES (?, ?, ?, ?, ?)`,
  );
  return (eventType, principalId, detail) =>
    insert.run(randomUUID(), now, eventType, principalId, JSON.stringify(detail));
}

function settleAgentNames(db: Db, now: number, audit: AuditWriter): void {
  const misnamed = db
    .prepare<[string], LiveAgentRow>(
      `SELECT id, principal_id, person, agent, level_id FROM access_host_agent_grants
        WHERE revoked_at IS NULL AND agent <> ? ORDER BY created_at, id`,
    )
    .all(HOST_AGENT_DEFAULT)
    .filter((row) => !GRANT_AGENT_PATTERN.test(row.agent));
  const taken = db.prepare<[string, string, string], { id: string }>(
    `SELECT id FROM access_host_agent_grants
      WHERE principal_id = ? AND person = ? AND agent = ? AND revoked_at IS NULL`,
  );
  const rename = db.prepare<[string, string]>(
    "UPDATE access_host_agent_grants SET agent = ? WHERE id = ?",
  );
  const revoke = db.prepare<[number, string]>(
    "UPDATE access_host_agent_grants SET revoked_at = ? WHERE id = ?",
  );
  for (const row of misnamed) {
    const lower = row.agent.trim().toLowerCase();
    if (GRANT_AGENT_PATTERN.test(lower) && !taken.get(row.principal_id, row.person, lower)) {
      rename.run(lower, row.id);
      audit("host-agent-renamed", row.principal_id, {
        hostAgentGrantId: row.id,
        person: row.person,
        from: row.agent,
        agent: lower,
        levelId: row.level_id,
      });
      continue;
    }
    revoke.run(now, row.id);
    audit("host-agent-revoked", row.principal_id, {
      hostAgentGrantId: row.id,
      person: row.person,
      agent: row.agent,
      levelId: row.level_id,
      reason: "invalid-agent-name",
    });
  }
}

function releaseRemovedConnections(db: Db, now: number, audit: AuditWriter): void {
  const removed = db
    .prepare<[], { principal_id: string }>(
      `SELECT b.principal_id FROM access_host_identity_bindings b
         JOIN access_principals p ON p.id = b.principal_id
        WHERE p.revoked_at IS NOT NULL
           OR NOT EXISTS (
             SELECT 1 FROM access_grants g
              WHERE g.principal_id = b.principal_id AND g.revoked_at IS NULL
           )
        ORDER BY b.principal_id`,
    )
    .all();
  const revoke = db.prepare<[number, string]>(
    `UPDATE access_host_agent_grants SET revoked_at = ?
      WHERE principal_id = ? AND revoked_at IS NULL`,
  );
  const unbind = db.prepare<[string]>(
    "DELETE FROM access_host_identity_bindings WHERE principal_id = ?",
  );
  for (const { principal_id: principalId } of removed) {
    revoke.run(now, principalId);
    unbind.run(principalId);
    audit("host-identity-unbound", principalId, { reason: "connection-removed" });
  }
}
