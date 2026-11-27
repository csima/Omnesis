// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SqliteQueryResult } from "../sqlite-catalog.js";

/** Passed as `workerData` when the `POST /sql` worker thread is spawned. */
export interface SqlQueryWorkerData {
  /** Path of the SQLite store; the worker opens its own read-only handle on it. */
  path: string;
  /** SQLCipher key as hex, or null when the store is not encrypted. */
  keyHex: string | null;
}

export interface MainToSqlQuery {
  id: number;
  sql: string;
  limit?: number;
}

export type SqlQueryToMain =
  | { type: "ready" }
  | { type: "initError"; message: string }
  | { type: "result"; id: number; result: SqliteQueryResult }
  | { type: "error"; id: number; message: string };
