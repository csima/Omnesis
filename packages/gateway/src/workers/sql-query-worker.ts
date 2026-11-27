// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Executes `POST /sql` queries off the gateway's main event loop. A user query
// over a large store can run for minutes inside SQLite's native code; on the
// main thread that stalls /health and every collector request behind it. Here
// it only ever stalls this thread, which the main thread can abandon.

import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { openEncryptedSqlite } from "../sqlite-encryption.js";
import { runSqliteQuery } from "../sqlite-catalog.js";
import type { MainToSqlQuery, SqlQueryToMain, SqlQueryWorkerData } from "./sql-query-protocol.js";

if (!parentPort) throw new Error("sql-query-worker must run in a worker thread");

const port = parentPort;
const init = workerData as SqlQueryWorkerData;

function post(message: SqlQueryToMain): void {
  port.postMessage(message);
}

let db: Database.Database | null = null;
try {
  // The same handle the main thread's /sql used: read-only, same key, same pragmas.
  db = init.keyHex
    ? (openEncryptedSqlite(init.path, {
        key: Buffer.from(init.keyHex, "hex"),
        readonly: true,
        fileMustExist: true,
        migratePlaintext: false,
      }) as unknown as Database.Database)
    : new Database(init.path, { readonly: true, fileMustExist: true });
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA mmap_size = 0");
  post({ type: "ready" });
} catch (error) {
  post({ type: "initError", message: error instanceof Error ? error.message : String(error) });
}

port.on("message", (message: MainToSqlQuery) => {
  if (!db) {
    post({ type: "error", id: message.id, message: "SQL worker has no database handle" });
    return;
  }
  try {
    const result = runSqliteQuery(db, { sql: message.sql, limit: message.limit });
    post({ type: "result", id: message.id, result });
  } catch (error) {
    post({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
