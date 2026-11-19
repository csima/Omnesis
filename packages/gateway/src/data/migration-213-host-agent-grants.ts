// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/**
 * Agent hosts that say who is calling.
 *
 * `access_host_identity_bindings` marks a connection as one an agent host
 * calls through on behalf of many agents: the host's issuer and the audience
 * its per-call identity assertions must name. A bound connection answers a
 * tool call only with a valid assertion, and only within the grants below.
 *
 * `access_host_agent_grants` gives one agent of that host, acting for one
 * person, an access level. A row is live until revoked; a level that is
 * retired takes its rows with it at read time, so nothing here needs a
 * cascade to fail closed. Installed on fresh databases by
 * `createAccessTables` and on upgrades by migration 213; idempotent.
 */
export function createHostAgentGrantTables(db: Db): void {
  const hasTable = (name: string) =>
    db
      .prepare<[string], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== undefined;
  if (!hasTable("access_principals") || !hasTable("access_levels")) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_host_identity_bindings (
      principal_id TEXT PRIMARY KEY REFERENCES access_principals(id) ON DELETE CASCADE,
      issuer TEXT NOT NULL,
      audience TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS access_host_agent_grants (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES access_principals(id) ON DELETE CASCADE,
      person TEXT NOT NULL,
      agent TEXT NOT NULL,
      level_id TEXT NOT NULL REFERENCES access_levels(id),
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_access_host_agent_grants_live
      ON access_host_agent_grants(principal_id, person, agent) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_access_host_agent_grants_level
      ON access_host_agent_grants(level_id) WHERE revoked_at IS NULL;
  `);
}
