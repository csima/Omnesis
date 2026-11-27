// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `POST /sql` runs in a worker thread under a deadline, so a slow query cannot
 * freeze the gateway's event loop. These tests use a real on-disk store and a
 * real worker: the property is about threads, which a stub cannot show.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCOPE_ADMIN } from "@omnesis/types";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { openEncryptedSqlite } from "../../sqlite-encryption.js";
import { resolveSqlTimeoutMs, type SqlQueryRunner } from "../../sql-query-runner.js";
import { errorResponse, HttpError } from "../errors.js";
import { scope, strictRoute } from "../scope.js";
import { mountAnalyticsRoutes } from "./analytics.js";
import type { AnalyticsRoutesDeps } from "./analytics.js";
import type { AnalyticsService } from "../services/AnalyticsService.js";
import type { AppEnv } from "./types.js";

/** A query that burns CPU inside SQLite for a few seconds (no table needed). */
const slowSql = (rows: number) =>
  `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<${rows}) SELECT count(*) AS n FROM c`;

let dir: string;
let plainPath: string;
let encryptedPath: string;
const key = randomBytes(32);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-sql-worker-"));
  plainPath = join(dir, "plain.db");
  const plain = new Database(plainPath);
  plain.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, label TEXT)");
  plain.exec("INSERT INTO probe (label) VALUES ('alpha'), ('beta')");
  plain.close();

  encryptedPath = join(dir, "encrypted.db");
  const enc = openEncryptedSqlite(encryptedPath, { key });
  enc.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, label TEXT)");
  enc.exec("INSERT INTO probe (label) VALUES ('sealed')");
  enc.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const runners: SqlQueryRunner[] = [];
const handles: Database.Database[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.close()));
  for (const h of handles.splice(0)) h.close();
});

function appFor(
  path: string,
  extra: Partial<AnalyticsRoutesDeps> = {},
  opts: { writable?: boolean } = {},
): Hono<AppEnv> {
  const db = opts.writable
    ? new Database(path)
    : (new Database(path, { readonly: true }) as Database.Database);
  handles.push(db);
  const app = strictRoute(new Hono<AppEnv>());
  app.use("*", async (c, next) => {
    c.set("auth", { authMethod: "bearer", scopes: [SCOPE_ADMIN], tokenId: null, deviceId: null });
    await next();
  });
  app.get("/health", scope.public(), (c) => c.json({ status: "ok" }));
  mountAnalyticsRoutes(app, {
    db: db as unknown as AnalyticsRoutesDeps["db"],
    analyticsService: null as unknown as AnalyticsService,
    sourceService: {} as AnalyticsRoutesDeps["sourceService"],
    onSqlQueryRunner: (r) => runners.push(r),
    ...extra,
  });
  app.onError((err, c) => {
    if (err instanceof HttpError) return errorResponse(c, err);
    throw err;
  });
  return app;
}

function post(app: Hono<AppEnv>, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request("/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /sql in a worker thread", () => {
  test("a SELECT answers as it did on the main thread", async () => {
    const res = await post(appFor(plainPath), { sql: "SELECT id, label FROM probe ORDER BY id" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.columns).toEqual(["id", "label"]);
    expect(data.columnTypes).toEqual(["INTEGER", "TEXT"]);
    expect(data.rows).toEqual([
      [1, "alpha"],
      [2, "beta"],
    ]);
    expect(data.rowCount).toBe(2);
    expect(typeof data.timing).toBe("number");
  }, 30_000);

  test("opens an encrypted store with the same key", async () => {
    // Only the worker reads the store, so it is the one that needs the key.
    const res = await post(appFor(encryptedPath, { sqlEncryptionKey: key }), {
      sql: "SELECT label FROM probe",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rows: unknown[][] }).rows).toEqual([["sealed"]]);
  }, 30_000);

  test("writes are refused by the worker's read-only handle", async () => {
    const res = await post(appFor(plainPath, {}, { writable: true }), {
      sql: "INSERT INTO probe (label) VALUES ('nope')",
    });
    expect(res.status).toBe(400);
    // The query is wrapped as a sub-select, so SQLite may name the syntax rather than
    // the read-only handle; either way nothing is written.
    expect(((await res.json()) as { error: string }).error).toMatch(
      /readonly|read-only|syntax error/i,
    );
    const count = await post(appFor(plainPath), { sql: "SELECT count(*) FROM probe" });
    expect(((await count.json()) as { rows: unknown[][] }).rows).toEqual([[2]]);
  }, 30_000);

  test("a bad query is a 400 and the worker stays usable", async () => {
    const app = appFor(plainPath);
    const bad = await post(app, { sql: "SELECT * FROM no_such_table" });
    expect(bad.status).toBe(400);
    const ok = await post(app, { sql: "SELECT 1 AS one" });
    expect(ok.status).toBe(200);
  }, 30_000);

  test("an in-memory store runs inline", async () => {
    const mem = new Database(":memory:");
    mem.exec("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (7)");
    handles.push(mem);
    const app = strictRoute(new Hono<AppEnv>());
    app.use("*", async (c, next) => {
      c.set("auth", {
        authMethod: "bearer",
        scopes: [SCOPE_ADMIN],
        tokenId: null,
        deviceId: null,
      });
      await next();
    });
    mountAnalyticsRoutes(app, {
      db: mem as unknown as AnalyticsRoutesDeps["db"],
      analyticsService: null as unknown as AnalyticsService,
      sourceService: {} as AnalyticsRoutesDeps["sourceService"],
      onSqlQueryRunner: (r) => runners.push(r),
    });
    const res = await post(app, { sql: "SELECT v FROM t" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rows: unknown[][] }).rows).toEqual([[7]]);
  });

  test("a slow query does not block the event loop or /health", async () => {
    const app = appFor(plainPath);
    // Warm the worker so the measurement below is the query, not the spawn.
    expect((await post(app, { sql: "SELECT 1" })).status).toBe(200);

    let maxGap = 0;
    let last = Date.now();
    const ticker = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 20);
    try {
      const slow = post(app, { sql: slowSql(30_000_000) });
      await new Promise((r) => setTimeout(r, 200));
      const t0 = Date.now();
      const health = await app.request("/health");
      const healthMs = Date.now() - t0;
      expect(health.status).toBe(200);
      expect(healthMs).toBeLessThan(500);
      const res = await slow;
      expect(res.status).toBe(200);
      // The query ran for seconds; the main thread never stalled for anywhere near that.
      expect(((await res.json()) as { timing: number }).timing).toBeGreaterThan(1000);
    } finally {
      clearInterval(ticker);
    }
    expect(maxGap).toBeLessThan(500);
  }, 60_000);

  test("a query past the deadline is a 504 with a hint, and the next query respawns a worker", async () => {
    const app = appFor(plainPath, { sqlTimeoutMs: 1_000 });
    expect((await post(app, { sql: "SELECT 1" })).status).toBe(200);

    const started = Date.now();
    const slow = await post(app, { sql: slowSql(50_000_000) });
    const elapsed = Date.now() - started;
    expect(slow.status).toBe(504);
    expect(elapsed).toBeLessThan(3_000);
    const body = (await slow.json()) as { error: string; code: string; detail?: unknown };
    expect(body.code).toBe("GATEWAY_TIMEOUT");
    expect(body.error).toContain("1000 ms");
    expect(body.error).toContain("source_id =");
    expect(body.detail).toEqual({ timeoutMs: 1000 });

    const after = await post(app, { sql: "SELECT label FROM probe ORDER BY id" });
    expect(after.status).toBe(200);
    expect(((await after.json()) as { rows: unknown[][] }).rows).toEqual([["alpha"], ["beta"]]);
  }, 60_000);

  test("close() stops the worker and refuses later queries", async () => {
    const app = appFor(plainPath);
    expect((await post(app, { sql: "SELECT 1" })).status).toBe(200);
    await runners[0]!.close();
    const res = await post(app, { sql: "SELECT 1" });
    expect(res.status).toBe(400);
  }, 30_000);
});

describe("resolveSqlTimeoutMs", () => {
  test("defaults to 15 s", () => {
    expect(resolveSqlTimeoutMs({})).toBe(15_000);
    expect(resolveSqlTimeoutMs({ OMNESIS_SQL_TIMEOUT_MS: "" })).toBe(15_000);
    expect(resolveSqlTimeoutMs({ OMNESIS_SQL_TIMEOUT_MS: "soon" })).toBe(15_000);
  });

  test("clamps to 1 s .. 60 s", () => {
    expect(resolveSqlTimeoutMs({ OMNESIS_SQL_TIMEOUT_MS: "5" })).toBe(1_000);
    expect(resolveSqlTimeoutMs({ OMNESIS_SQL_TIMEOUT_MS: "20000" })).toBe(20_000);
    expect(resolveSqlTimeoutMs({ OMNESIS_SQL_TIMEOUT_MS: "999999" })).toBe(60_000);
  });
});
