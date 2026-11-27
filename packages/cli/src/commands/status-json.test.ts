// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_REQUEST_TIMEOUT_S, parseRequestTimeoutMs } from "./sql.js";
import type { AddressInfo } from "node:net";

const execFileAsync = promisify(execFile);
const entry = fileURLToPath(new URL("../index.ts", import.meta.url));

/** Fictional gateway answering only what `omnesis status` reads. */
const ROUTES: Record<string, unknown> = {
  "/admin/sources": { items: [{ id: "example-notes:demo", config: { syncInterval: "5m" } }] },
  "/admin/sync/status": {
    items: [
      {
        sourceId: "example-notes:demo",
        providerId: "example-notes:demo",
        state: "idle",
        lastSyncAt: 1_700_000_000_000,
      },
    ],
  },
  "/status": { dbSizeBytes: 4096, documents: { total: 3, bySource: { "example-notes:demo": 3 } } },
  "/index/stats": null,
  "/analytics/catalog": { tables: [] },
  "/admin/source-descriptors": { items: [] },
  "/admin/process-vitals": null,
  "/health": { version: "9.9.9-test" },
  "/admin/devices": { items: [] },
};

describe("omnesis status --json", () => {
  let server: Server;
  let configDir: string;
  let url: string;

  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), "omnesis-status-json-"));
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      res.setHeader("content-type", "application/json");
      if (path === "/documents/stats") {
        res.end(JSON.stringify({ stats: {} }));
        return;
      }
      if (path in ROUTES) {
        res.end(JSON.stringify(ROUTES[path]));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(configDir, { recursive: true, force: true });
  });

  it("prints the status payload as JSON and exits 0, not the text table", async () => {
    const { stdout } = await execFileAsync("npx", ["tsx", entry, "status", "--json"], {
      env: {
        ...process.env,
        OMNESIS_CONFIG_DIR: configDir,
        OMNESIS_GATEWAY_URL: url,
        OMNESIS_TOKEN: "fictional-test-token",
      },
    });
    const payload = JSON.parse(stdout) as {
      statuses: Array<{ sourceId: string; state: string }>;
      gatewayVersion: string | null;
      timestamp: string;
      dbSizeBytes: number | null;
    };
    expect(payload.gatewayVersion).toBe("9.9.9-test");
    expect(payload.statuses).toHaveLength(1);
    expect(payload.statuses[0]).toMatchObject({ sourceId: "example-notes:demo", state: "idle" });
    expect(payload.dbSizeBytes).toBe(4096);
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
  }, 60_000);
});

describe("omnesis sql --timeout", () => {
  it("waits past the gateway's 60 s ceiling by default", () => {
    expect(parseRequestTimeoutMs(undefined)).toBe(DEFAULT_REQUEST_TIMEOUT_S * 1000);
    expect(DEFAULT_REQUEST_TIMEOUT_S).toBeGreaterThan(60);
  });

  it("takes seconds", () => {
    expect(parseRequestTimeoutMs("20")).toBe(20_000);
    expect(parseRequestTimeoutMs("1.5")).toBe(1_500);
  });

  it("refuses a value that is not a positive number", () => {
    expect(() => parseRequestTimeoutMs("0")).toThrow(/positive/);
    expect(() => parseRequestTimeoutMs("soon")).toThrow(/positive/);
  });
});
