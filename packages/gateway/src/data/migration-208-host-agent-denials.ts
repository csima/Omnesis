// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/**
 * Host agents that are denied by name, and no host access left behind a
 * removed connection.
 *
 * A row of `access_host_agent_grants` whose `level_id` is null denies that
 * agent any access, even where the person's default would admit it. Migration
 * 206 made `level_id` required, so the table is rebuilt with it nullable; no
 * other table references it, so the rebuild runs inside the runner's
 * transaction and keeps every row and id.
 *
 * A connection that was removed before host access followed it out still has
 * its binding and live agent grants. They are released here: the grants are
 * revoked and the binding dropped, as removing the connection now does.
 *
 * Idempotent: the rebuild runs only while `level_id` is still required, and a
 * released connection has nothing left to release. Installed on fresh
 * databases by `createAccessTables` after migration 206's tables.
 */
export function allowHostAgentDenials(db: Db, now = Date.now()): void {
  const present = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'access_host_agent_grants'",
    )
    .get();
  if (!present) return;
  const levelColumn = db
    .prepare<[], { name: string; notnull: number }>(
      "SELECT name, \"notnull\" FROM pragma_table_info('access_host_agent_grants')",
    )
    .all()
    .find((column) => column.name === "level_id");
  if (levelColumn?.notnull === 1) {
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
  const gone = `SELECT b.principal_id FROM access_host_identity_bindings b
                 JOIN access_principals p ON p.id = b.principal_id
                WHERE p.revoked_at IS NOT NULL
                   OR NOT EXISTS (
                     SELECT 1 FROM access_grants g
                      WHERE g.principal_id = b.principal_id AND g.revoked_at IS NULL
                   )`;
  db.prepare(
    `UPDATE access_host_agent_grants SET revoked_at = ?
      WHERE revoked_at IS NULL AND principal_id IN (${gone})`,
  ).run(now);
  db.exec(`DELETE FROM access_host_identity_bindings WHERE principal_id IN (${gone})`);
}
