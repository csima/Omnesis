// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Worker } from "node:worker_threads";
import { createLogger, resolveWorkerEntry } from "@omnesis/core";
import { runSqliteQuery, type SqliteQueryResult } from "./sqlite-catalog.js";
import type Database from "better-sqlite3";
import type {
  MainToSqlQuery,
  SqlQueryToMain,
  SqlQueryWorkerData,
} from "./workers/sql-query-protocol.js";

const log = createLogger("gateway:sql");

export const SQL_TIMEOUT_DEFAULT_MS = 15_000;
export const SQL_TIMEOUT_MIN_MS = 1_000;
export const SQL_TIMEOUT_MAX_MS = 60_000;
/** Bound on opening the store in a fresh worker (kept apart from the query timeout). */
const WORKER_START_TIMEOUT_MS = 30_000;
/** A worker idle this long is retired; the next query respawns one. */
const IDLE_RETIRE_MS = 60_000;
/**
 * Abandoned workers still inside a native SQLite call cannot be interrupted;
 * they exit when the call returns. Past this many, new queries are refused
 * rather than piling up more threads that are each scanning the store.
 */
const MAX_ABANDONED_WORKERS = 2;

/** `OMNESIS_SQL_TIMEOUT_MS`, clamped to 1s..60s; 15s when unset or not a number. */
export function resolveSqlTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OMNESIS_SQL_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return SQL_TIMEOUT_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return SQL_TIMEOUT_DEFAULT_MS;
  return Math.min(SQL_TIMEOUT_MAX_MS, Math.max(SQL_TIMEOUT_MIN_MS, Math.trunc(n)));
}

/** The query ran past its budget and its worker was abandoned. */
export class SqlQueryTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`SQL query exceeded the ${timeoutMs} ms limit and was cancelled`);
    this.name = "SqlQueryTimeoutError";
  }
}

/** Earlier timed-out queries are still running to completion; try again shortly. */
export class SqlWorkerBusyError extends Error {
  constructor() {
    super("Earlier SQL queries that timed out are still winding down; retry shortly");
    this.name = "SqlWorkerBusyError";
  }
}

/** SQLite rejected the query (syntax, unknown table, write attempt, ...). */
export class SqlQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlQueryError";
  }
}

export interface SqlQueryRunnerOptions {
  /** The store's path. In-memory stores cannot be reopened by a worker. */
  dbPath: string;
  /** In-memory handles fall back to running inline on the calling thread. */
  inlineDb?: Database.Database;
  encryptionKey?: Buffer | null;
  timeoutMs?: number;
}

interface InFlight {
  id: number;
  resolve: (r: SqliteQueryResult) => void;
  reject: (e: Error) => void;
}

/**
 * Runs read-only user SQL in a dedicated worker thread with a hard per-query
 * deadline. Queries run one at a time (a worker is single-threaded anyway), so
 * each deadline measures the query's own run, not time spent queued.
 */
export class SqlQueryRunner {
  private readonly timeoutMs: number;
  private worker: Worker | null = null;
  private workerReady: Promise<void> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private current: InFlight | null = null;
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly abandoned = new Set<Worker>();
  private closed = false;

  constructor(private readonly options: SqlQueryRunnerOptions) {
    this.timeoutMs = options.timeoutMs ?? resolveSqlTimeoutMs();
  }

  get queryTimeoutMs(): number {
    return this.timeoutMs;
  }

  run(opts: { sql: string; limit?: number }): Promise<SqliteQueryResult> {
    if (this.closed) return Promise.reject(new Error("SQL runner is closed"));
    if (this.options.inlineDb && isInMemory(this.options.dbPath)) {
      try {
        return Promise.resolve(runSqliteQuery(this.options.inlineDb, opts));
      } catch (err) {
        return Promise.reject(new SqlQueryError(err instanceof Error ? err.message : String(err)));
      }
    }
    const result = this.tail.then(() => this.execute(opts));
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Stop the worker. Safe to call repeatedly; later `run`s are refused. */
  async close(): Promise<void> {
    this.closed = true;
    this.clearIdle();
    const worker = this.worker;
    this.worker = null;
    this.workerReady = null;
    this.current?.reject(new Error("SQL runner is closed"));
    this.current = null;
    if (worker) await worker.terminate().catch(() => undefined);
    for (const w of this.abandoned) void w.terminate().catch(() => undefined);
  }

  private async execute(opts: { sql: string; limit?: number }): Promise<SqliteQueryResult> {
    if (this.closed) throw new Error("SQL runner is closed");
    if (this.abandoned.size >= MAX_ABANDONED_WORKERS) throw new SqlWorkerBusyError();
    this.clearIdle();
    const worker = this.ensureWorker();
    await this.workerReady;
    if (this.worker !== worker) throw new Error("SQL worker went away before the query started");

    const id = this.nextId++;
    return new Promise<SqliteQueryResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.current?.id !== id) return;
        this.current = null;
        this.abandon(worker);
        reject(new SqlQueryTimeoutError(this.timeoutMs));
      }, this.timeoutMs);
      const settle =
        <T>(fn: (v: T) => void) =>
        (v: T) => {
          clearTimeout(timer);
          fn(v);
          this.armIdle();
        };
      this.current = { id, resolve: settle(resolve), reject: settle(reject) };
      const message: MainToSqlQuery = { id, sql: opts.sql, limit: opts.limit };
      worker.postMessage(message);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const entry = resolveWorkerEntry(
      "./workers/sql-query-worker.ts",
      import.meta.url,
      "./workers/register-tsx.mjs",
    );
    const data: SqlQueryWorkerData = {
      path: this.options.dbPath,
      keyHex: this.options.encryptionKey ? this.options.encryptionKey.toString("hex") : null,
    };
    const worker = new Worker(entry.url, { execArgv: entry.execArgv, workerData: data });
    // A parked or abandoned worker must never hold the gateway process open.
    worker.unref();
    this.worker = worker;

    let startTimer: ReturnType<typeof setTimeout> | undefined;
    this.workerReady = new Promise<void>((resolve, reject) => {
      startTimer = setTimeout(() => {
        reject(new SqlQueryError("SQL worker did not start in time"));
        this.retire(worker);
      }, WORKER_START_TIMEOUT_MS);
      startTimer.unref();
      worker.on("message", (msg: SqlQueryToMain) => {
        if (msg.type === "ready") {
          clearTimeout(startTimer);
          resolve();
        } else if (msg.type === "initError") {
          clearTimeout(startTimer);
          reject(new SqlQueryError(msg.message));
          this.retire(worker);
        } else if (this.current && this.current.id === msg.id) {
          const cur = this.current;
          this.current = null;
          if (msg.type === "result") cur.resolve(msg.result);
          else cur.reject(new SqlQueryError(msg.message));
        }
      });
    });
    void this.workerReady.catch(() => undefined);

    worker.on("error", (err) => {
      log.warn(`SQL worker error: ${err.message}`);
      this.failCurrent(worker, new SqlQueryError(`SQL worker failed: ${err.message}`));
    });
    worker.on("exit", () => {
      clearTimeout(startTimer);
      this.abandoned.delete(worker);
      this.failCurrent(worker, new SqlQueryError("SQL worker exited unexpectedly"));
      if (this.worker === worker) {
        this.worker = null;
        this.workerReady = null;
      }
    });
    return worker;
  }

  private failCurrent(worker: Worker, err: Error): void {
    if (this.worker === worker && this.current) {
      const cur = this.current;
      this.current = null;
      cur.reject(err);
    }
  }

  /** Drop a worker we are done with (init failure); the next query respawns. */
  private retire(worker: Worker): void {
    if (this.worker === worker) {
      this.worker = null;
      this.workerReady = null;
    }
    void worker.terminate().catch(() => undefined);
  }

  /**
   * Give up on a worker stuck in a query. `terminate()` takes effect once the
   * native SQLite call returns, so the main thread does not wait for it; the
   * worker is tracked until it actually exits.
   */
  private abandon(worker: Worker): void {
    if (this.worker === worker) {
      this.worker = null;
      this.workerReady = null;
    }
    this.abandoned.add(worker);
    log.warn(`SQL query exceeded ${this.timeoutMs} ms; abandoning its worker thread`);
    void worker.terminate().catch(() => undefined);
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.worker && !this.current) this.retire(this.worker);
    }, IDLE_RETIRE_MS);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function isInMemory(path: string): boolean {
  return path === "" || path === ":memory:" || path.startsWith("file::memory:");
}
