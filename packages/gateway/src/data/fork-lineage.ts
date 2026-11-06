// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, type Logger } from "@omnesis/core";
import type { Db } from "./types.js";

const log = createLogger("gateway:migrations");

/**
 * The migrations a database from the `csima/Omnesis` fork recorded as 206-209,
 * before upstream numbered its own 206-211. On this branch they run again as
 * 213, 214, 215 and 212.
 */
export const FORK_LINEAGE_MIGRATIONS: ReadonlyArray<{ version: number; description: string }> = [
  {
    version: 206,
    description: "agent hosts that say who is calling, and the access level of each host agent",
  },
  {
    version: 207,
    description:
      "mark stored web pages and visits due a background redaction pass with the shaped rules",
  },
  {
    version: 208,
    description: "host agents denied by name, and no host access left behind a removed connection",
  },
  {
    version: 209,
    description: "index the date pass's pending documents by arrival again",
  },
];

/** The schema both lineages share: the last migration before they diverged. */
export const FORK_LINEAGE_BASE = 205;

/**
 * Move a database the fork migrated past {@link FORK_LINEAGE_BASE} back onto
 * this build's chain. Its `user_version` says 206-209, but those numbers name
 * the fork's migrations, so the runner would skip upstream's 206-211 for good.
 * Rewinding to 205 and dropping the fork's history rows lets the runner apply
 * upstream's 206-211 and then the fork's own steps under their new numbers;
 * each of those is idempotent, so running them again over their own work
 * changes nothing. A database is taken for the fork's only when every history
 * row it holds from 206 on is the fork's, so upstream databases are never
 * touched. Runs before the migration runner, in one transaction.
 */
export function rewindForkLineage(db: Db, opts?: { log?: Logger }): boolean {
  const logger = opts?.log ?? log;
  const version = db.prepare<[], { user_version: number }>("PRAGMA user_version").get()!
    .user_version;
  const last = FORK_LINEAGE_MIGRATIONS[FORK_LINEAGE_MIGRATIONS.length - 1]!.version;
  if (version <= FORK_LINEAGE_BASE || version > last) return false;
  const rows = db
    .prepare<[number], { version: number; description: string }>(
      "SELECT version, description FROM schema_migrations WHERE version > ? ORDER BY version",
    )
    .all(FORK_LINEAGE_BASE);
  const fork = new Map(FORK_LINEAGE_MIGRATIONS.map((m) => [m.version, m.description]));
  const isFork =
    rows.length > 0 &&
    rows[0]!.version === FORK_LINEAGE_BASE + 1 &&
    rows.every((row) => fork.get(row.version) === row.description);
  if (!isFork) return false;
  db.transaction(() => {
    db.prepare("DELETE FROM schema_migrations WHERE version > ?").run(FORK_LINEAGE_BASE);
    db.exec(`PRAGMA user_version = ${FORK_LINEAGE_BASE}`);
  })();
  logger.warn(
    `schema from the csima/Omnesis fork at v${version}: rewound to v${FORK_LINEAGE_BASE} so upstream's ` +
      `migrations from v${FORK_LINEAGE_BASE + 1} run, then the fork's again under their new numbers`,
  );
  return true;
}
