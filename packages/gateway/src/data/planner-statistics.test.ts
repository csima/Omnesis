// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Planner statistics: the writer analyzes what `PRAGMA optimize` would, one
 * index at a time, and the statistics it leaves are the ones SQLite's own
 * pragma would have left. The plan suite runs the hot writer operations on an
 * invented corpus shaped like a large install, captures every statement they
 * prepare, and holds each one's plan after analysis to what it was before:
 * no statement may begin scanning a large table, or sorting, because the
 * planner now has statistics.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createDatabase, upsertWithCursor } from "../db.js";
import { setActiveAlgoVersion } from "../near-dupes/meta.js";
import { applyNearDupBatch, BUCKET_DELETE_FOR_DOC_SQL } from "../near-dupes/NearDupWriterOps.js";
import {
  advanceKnowledgeCascade,
  KNOWLEDGE_CASCADE_NEXT_JOB_SQL,
  KNOWLEDGE_CASCADE_NEXT_ROW_SQL,
} from "../brain/knowledge/storage-invalidation.js";
import { backfillManyPeople } from "../domain/PeopleResolutionService.js";
import {
  acceptCollapsedMergeCandidates,
  findCollapsedMergeCandidates,
} from "../merge-candidates.js";
import {
  PILOT_ALGO,
  pilotDocId,
  pilotEmail,
  seedPilotCorpus,
} from "../scheduler/__fixtures__/pilot-corpus.js";
import {
  analysisUnits,
  OPTIMIZE_PLAN_MASK,
  PLANNER_ANALYSIS_LIMIT,
  planPlannerStatistics,
  refreshPlannerStatistics,
} from "./planner-statistics.js";
import type { NearDupApplyBatch } from "../near-dupes/types.js";

type Db = Database.Database;

const CORPUS_DOCS = 8_000;
const LARGE_TABLES = [
  "documents",
  "document_people",
  "people",
  "person_aliases",
  "near_dup_lsh_buckets",
  "near_dup_signatures",
  "knowledge_cascade_jobs",
  "knowledge_cascade_frontier",
  "knowledge_source_revisions",
  "knowledge_changes",
];

const paths: string[] = [];

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
}

function seeded(docs = 2_000): { db: Db; path: string } {
  const path = `/tmp/omnesis-test-${randomUUID()}.db`;
  paths.push(path);
  const db = createDatabase(path) as unknown as Db;
  setActiveAlgoVersion(db as never, PILOT_ALGO);
  seedPilotCorpus(db, { docs, unresolvedDocs: 60, pendingCandidates: 120 });
  return { db, path };
}

function stat1(db: Db): string[] {
  return db
    .prepare<[], { tbl: string; idx: string | null; stat: string }>(
      "SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx",
    )
    .all()
    .map((r) => `${r.tbl}|${r.idx}|${r.stat}`);
}

function indexedTables(db: Db, tables: readonly string[]): string[] {
  return tables.filter(
    (t) =>
      db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM pragma_index_list(?)").get(t)!
        .n > 0,
  );
}

afterAll(() => {
  for (const path of paths) cleanupDb(path);
});

describe("refreshPlannerStatistics", () => {
  const open: Db[] = [];
  afterEach(() => {
    for (const db of open.splice(0)) db.close();
  });

  test("a never-analyzed database plans every indexed table, and none once analyzed", () => {
    const { db } = seeded();
    open.push(db);
    const planned = planPlannerStatistics(db);
    expect(planned).toEqual(expect.arrayContaining(LARGE_TABLES));
    const result = refreshPlannerStatistics(db, undefined);
    expect(result.remaining).toEqual([]);
    expect(result.analyzed).toEqual(planned.flatMap((t) => analysisUnits(db, t)));
    expect(indexedTables(db, planPlannerStatistics(db))).toEqual([]);
    expect(refreshPlannerStatistics(db, undefined).analyzed).toEqual(
      planPlannerStatistics(db).flatMap((t) => analysisUnits(db, t)),
    );
  });

  test("index-at-a-time analysis leaves what SQLite's own PRAGMA optimize leaves", () => {
    const ours = seeded();
    const sqlites = seeded();
    open.push(ours.db, sqlites.db);
    refreshPlannerStatistics(ours.db, undefined);
    sqlites.db.pragma(`analysis_limit = ${PLANNER_ANALYSIS_LIMIT}`);
    sqlites.db.prepare(`PRAGMA optimize(${OPTIMIZE_PLAN_MASK & ~1})`).all();
    expect(stat1(ours.db)).toEqual(stat1(sqlites.db));
    expect(stat1(ours.db).length).toBeGreaterThan(50);
  });

  test("stops between units and resumes to the same statistics", () => {
    const sliced = seeded();
    const whole = seeded();
    open.push(sliced.db, whole.db);
    let units = 0;
    let progress = refreshPlannerStatistics(sliced.db, undefined, {
      shouldStop: () => ++units > 3,
    });
    expect(progress.analyzed.length).toBe(4);
    expect(progress.remaining.length).toBeGreaterThan(0);
    let calls = 1;
    while (progress.remaining.length > 0) {
      let budget = 0;
      progress = refreshPlannerStatistics(sliced.db, progress.remaining, {
        shouldStop: () => ++budget > 5,
      });
      calls += 1;
    }
    expect(calls).toBeGreaterThan(2);
    refreshPlannerStatistics(whole.db, undefined);
    expect(stat1(sliced.db)).toEqual(stat1(whole.db));
  });

  test("restores the connection's own analysis limit and skips a dropped unit", () => {
    const { db } = seeded(200);
    open.push(db);
    db.pragma("analysis_limit = 77");
    db.exec(
      "CREATE TABLE synth_scratch (id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX synth_scratch_v ON synth_scratch(v)",
    );
    db.exec("INSERT INTO synth_scratch (v) VALUES ('a'), ('b')");
    const units = analysisUnits(db, "synth_scratch");
    expect(units).toEqual(["synth_scratch_v"]);
    db.exec("DROP TABLE synth_scratch");
    const result = refreshPlannerStatistics(db, [...units, "people"]);
    expect(result.analyzed).toEqual(["people"]);
    expect(db.pragma("analysis_limit", { simple: true })).toBe(77);
  });
});

interface Captured {
  op: string;
  sql: string;
  args: unknown[];
}

/** Every SELECT/INSERT/UPDATE/DELETE `run` prepares, with the arguments it first ran with. */
function captureStatements(db: Db, ops: Array<[string, () => unknown]>): Captured[] {
  const captured = new Map<string, Captured>();
  const prepare = db.prepare.bind(db);
  let op = "";
  (db as unknown as { prepare: (sql: string) => Database.Statement }).prepare = (sql: string) => {
    const stmt = prepare(sql);
    if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)/i.test(sql)) return stmt;
    const key = sql.replace(/\s+/g, " ").trim();
    for (const method of ["run", "get", "all", "iterate"] as const) {
      const original = stmt[method].bind(stmt) as (...a: unknown[]) => unknown;
      (stmt as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        if (!captured.has(key)) captured.set(key, { op, sql, args });
        return original(...args);
      };
    }
    return stmt;
  };
  try {
    for (const [name, run] of ops) {
      op = name;
      run();
    }
  } finally {
    (db as unknown as { prepare: typeof prepare }).prepare = prepare;
  }
  return [...captured.values()];
}

function explain(db: Db, sql: string, args: unknown[] = []): string[] {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as Array<{
      detail: string;
    }>
  ).map((r) => r.detail);
}

function scannedLargeTables(plan: readonly string[]): string[] {
  return plan
    .map((detail) => /^SCAN (\w+)/.exec(detail)?.[1])
    .filter((t): t is string => !!t && LARGE_TABLES.includes(t))
    .filter((t, i, all) => all.indexOf(t) === i);
}

function hotWriterOps(db: Db): Array<[string, () => unknown]> {
  const mailPage = (n: number, offset: number, update: boolean) =>
    Array.from({ length: n }, (_, k) => {
      const i = offset + k;
      return {
        providerId: "synth-mail",
        sourceId: "synth-mail-work",
        externalId: update ? `ext-${i}` : `ext-new-${i}`,
        title: `Weekly sync ${i}`,
        content: `Status update ${i}`,
        contentHash: `hash-v2-${i}`,
        metadata: {
          documentType: "email",
          people: [{ role: "sender" as const, emails: [pilotEmail(1 + (i % 40))] }],
          extra: { threadId: `thread-${i}` },
        },
        sourceCreatedAt: "2026-10-20T10:00:00Z",
        sourceUpdatedAt: "2026-10-20T10:00:00Z",
      };
    });
  const nearDupDoc = pilotDocId(42);
  const nearDupBatch: NearDupApplyBatch = {
    algoVersion: PILOT_ALGO,
    processedInboxIds: [],
    signatureDeletes: [nearDupDoc],
    signatures: [
      {
        docId: nearDupDoc,
        algoVersion: PILOT_ALGO,
        signature: Buffer.alloc(64, 3),
        shingleCount: 40,
      },
    ],
    bucketRows: Array.from({ length: 16 }, (_, b) => ({
      algoVersion: PILOT_ALGO,
      bandIdx: b,
      bucketHash: b * 7,
      docId: nearDupDoc,
    })),
    edgeUpserts: [
      {
        docA: pilotDocId(0),
        docB: nearDupDoc,
        algoVersion: PILOT_ALGO,
        jaccard: 0.9,
        pairUniqueDf2: 3,
        pairUniqueDf5: 6,
        containmentMin: 0.95,
        gateFamily: "file-like",
      },
    ],
    edgeDeletes: [],
  };
  return [
    [
      "db.upsertWithCursor",
      () =>
        upsertWithCursor(
          db as never,
          {
            providerId: "synth-mail",
            sourceId: "synth-mail-work",
            documents: [...mailPage(40, 0, false), ...mailPage(40, 10, true)],
            deletedExternalIds: ["ext-20", "ext-21"],
            hasMore: true,
            cursor: { page: 2 },
          } as unknown as Parameters<typeof upsertWithCursor>[1],
        ),
    ],
    [
      "people.backfillManyPeople",
      () => backfillManyPeople(db as never, 20, { shouldStop: () => false }),
    ],
    ["knowledge.advanceCascade", () => advanceKnowledgeCascade(db as never, 100, Date.now())],
    ["nearDup.applyBatch", () => applyNearDupBatch(db as never, nearDupBatch)],
    [
      "people.acceptCollapsedMergeCandidates",
      () => acceptCollapsedMergeCandidates(db as never, findCollapsedMergeCandidates(db as never)),
    ],
  ];
}

describe("hot writer query plans on an analyzed corpus", () => {
  let db: Db;
  let path: string;
  let captured: Captured[];
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let fresh: Db;

  beforeAll(() => {
    ({ db, path } = seeded(CORPUS_DOCS));
    captured = captureStatements(db, hotWriterOps(db));
    before = new Map(captured.map((c) => [c.sql, explain(db, c.sql, c.args)]));
    refreshPlannerStatistics(db, undefined);
    fresh = new Database(path, { readonly: true });
    after = new Map(captured.map((c) => [c.sql, explain(fresh, c.sql, c.args)]));
  }, 120_000);

  afterAll(() => {
    fresh?.close();
    db?.close();
  });

  test("captures the statements of every hot writer op", () => {
    const ops = new Set(captured.map((c) => c.op));
    expect([...ops].sort()).toEqual(
      [
        "db.upsertWithCursor",
        "knowledge.advanceCascade",
        "nearDup.applyBatch",
        "people.acceptCollapsedMergeCandidates",
        "people.backfillManyPeople",
      ].sort(),
    );
    expect(captured.length).toBeGreaterThan(40);
  });

  test("no statement starts scanning a large table or sorting once statistics exist", () => {
    const regressions = captured.flatMap((c) => {
      const was = before.get(c.sql)!;
      const now = after.get(c.sql)!;
      const newScans = scannedLargeTables(now).filter((t) => !scannedLargeTables(was).includes(t));
      const newSort =
        now.some((d) => d.includes("TEMP B-TREE")) && !was.some((d) => d.includes("TEMP B-TREE"));
      return newScans.length > 0 || newSort ? [{ op: c.op, sql: c.sql, was, now }] : [];
    });
    expect(regressions).toEqual([]);
  });

  test("the cascade picks stay index seeks", () => {
    const jobPlan = explain(fresh, KNOWLEDGE_CASCADE_NEXT_JOB_SQL, ["invalidate"]).join("\n");
    expect(jobPlan).toMatch(/SEARCH j USING (COVERING )?INDEX knowledge_cascade_jobs_kind/);
    const rowPlan = explain(fresh, KNOWLEDGE_CASCADE_NEXT_ROW_SQL, [1]).join("\n");
    expect(rowPlan).toMatch(/SEARCH f USING (COVERING )?INDEX knowledge_cascade_work/);
    expect(rowPlan).not.toMatch(/TEMP B-TREE/);
  });

  test("statistics alone send the unpinned bucket delete to the doc index", () => {
    const unpinned = BUCKET_DELETE_FOR_DOC_SQL.replace(" INDEXED BY idx_near_dup_lsh_doc", "");
    const unanalyzedPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    paths.push(unanalyzedPath);
    const unanalyzed = createDatabase(unanalyzedPath) as unknown as Db;
    try {
      seedPilotCorpus(unanalyzed, { docs: 600 });
      expect(explain(unanalyzed, unpinned, [pilotDocId(6), PILOT_ALGO]).join("\n")).not.toMatch(
        /idx_near_dup_lsh_doc/,
      );
    } finally {
      unanalyzed.close();
    }
    expect(explain(fresh, unpinned, [pilotDocId(6), PILOT_ALGO]).join("\n")).toMatch(
      /SEARCH near_dup_lsh_buckets USING INDEX idx_near_dup_lsh_doc \(doc_id=\?\)/,
    );
    expect(
      explain(fresh, BUCKET_DELETE_FOR_DOC_SQL, [pilotDocId(6), PILOT_ALGO]).join("\n"),
    ).toMatch(/idx_near_dup_lsh_doc/);
  });
});
