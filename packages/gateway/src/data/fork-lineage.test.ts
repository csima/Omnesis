// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { createDatabase } from "../db.js";
import { FORK_LINEAGE_BASE, FORK_LINEAGE_MIGRATIONS, rewindForkLineage } from "./fork-lineage.js";
import { LATEST_SCHEMA_VERSION } from "./schema-version.js";
import type { Db } from "./types.js";

const paths: string[] = [];

function fresh(): { db: Db; path: string } {
  const path = `/tmp/omnesis-test-${randomUUID()}.db`;
  paths.push(path);
  return { db: createDatabase(path), path };
}

/** Rewrite a head database's history to what the fork recorded at `through`. */
function asFork(db: Db, through: number): void {
  db.prepare("DELETE FROM schema_migrations WHERE version > ?").run(FORK_LINEAGE_BASE);
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, description, run_at, duration_ms) VALUES (?, ?, 0, 0)",
  );
  for (const m of FORK_LINEAGE_MIGRATIONS)
    if (m.version <= through) insert.run(m.version, m.description);
  db.exec(`PRAGMA user_version = ${through}`);
}

const history = (db: Db) =>
  db
    .prepare<[number], { version: number; description: string }>(
      "SELECT version, description FROM schema_migrations WHERE version > ? ORDER BY version",
    )
    .all(FORK_LINEAGE_BASE);

afterEach(() => {
  for (const path of paths.splice(0))
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

describe("rewindForkLineage", () => {
  test("leaves an upstream database alone", () => {
    const { db } = fresh();
    const before = history(db);
    expect(rewindForkLineage(db)).toBe(false);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(history(db)).toEqual(before);
    db.close();
  });

  test("leaves a database upstream migrated into the overlapping numbers alone", () => {
    const { db } = fresh();
    db.prepare("DELETE FROM schema_migrations WHERE version > 207").run();
    db.exec("PRAGMA user_version = 207");
    expect(rewindForkLineage(db)).toBe(false);
    expect(db.pragma("user_version", { simple: true })).toBe(207);
    db.close();
  });

  test.each([206, 207, 208, 209])(
    "rewinds a fork database at v%i, and opening it again brings it to the head",
    (through) => {
      const { db, path } = fresh();
      asFork(db, through);
      expect(rewindForkLineage(db)).toBe(true);
      expect(db.pragma("user_version", { simple: true })).toBe(FORK_LINEAGE_BASE);
      expect(history(db)).toEqual([]);
      db.close();

      const reopened = createDatabase(path);
      expect(reopened.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      expect(history(reopened).map((r) => r.version)).toEqual(
        Array.from(
          { length: LATEST_SCHEMA_VERSION - FORK_LINEAGE_BASE },
          (_, i) => FORK_LINEAGE_BASE + 1 + i,
        ),
      );
      expect(rewindForkLineage(reopened)).toBe(false);
      reopened.close();
    },
  );
});
