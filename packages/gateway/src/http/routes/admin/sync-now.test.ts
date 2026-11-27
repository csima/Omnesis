// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { createDatabase } from "../../../db.js";
import { createServer } from "../../../server.js";
import { createDevice } from "../../../data/repositories/DeviceRepository.js";
import { createToken } from "../../../data/repositories/TokenRepository.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let app: ReturnType<typeof createServer>;
let dbPath: string;

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function post(token: string, body: unknown): Promise<Response> {
  return app.request("/admin/sync-now", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }) as Promise<Response>;
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  app = createServer(db, dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("POST /admin/sync-now", () => {
  test("404 for an unknown source id", async () => {
    const res = await post(mintToken([SCOPE_ADMIN, SCOPE_READ]), { sourceIds: ["gmail:nobody@x"] });
    expect(res.status).toBe(404);
  });

  test("404 for a source type with no sources", async () => {
    const res = await post(mintToken([SCOPE_ADMIN, SCOPE_READ]), { sourceType: "gmail" });
    expect(res.status).toBe(404);
  });

  test("400 when neither sourceIds nor sourceType is given", async () => {
    const res = await post(mintToken([SCOPE_ADMIN, SCOPE_READ]), {});
    expect(res.status).toBe(400);
  });

  test("400 for a non-positive timeout", async () => {
    const res = await post(mintToken([SCOPE_ADMIN, SCOPE_READ]), {
      sourceType: "gmail",
      timeoutMs: -5,
    });
    expect(res.status).toBe(400);
  });

  test("403 without the admin scope", async () => {
    const res = await post(mintToken([SCOPE_READ]), { sourceType: "gmail" });
    expect(res.status).toBe(403);
  });
});
