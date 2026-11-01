// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A gateway behind Cloudflare Access, end to end: a real gateway behind a
 * small local stand-in for the Access edge, which forwards only requests that
 * carry the machine's service token in `CF-Access-Client-Id` and
 * `CF-Access-Client-Secret`, WebSocket upgrades included. A request without
 * them is redirected to the Access login page, as Access does by default; one
 * with the wrong secret gets Cloudflare's own 403. Pairing (the real CLI, run
 * as a subprocess), a sync push and the device WebSocket all go through it.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CloudflareAccessRefusedError,
  installGatewayAccess,
  readGatewayAccessCredentials,
  readSecretTextFileSync,
  resetGatewayAccessForTests,
} from "@omnesis/core";
import { GatewayWsClient, HttpGatewayClient } from "@omnesis/gateway-client";
import { AccountId, ProviderId, SourceId, SourceType, type DocumentInput } from "@omnesis/types";
import { MultiCollectorHarness } from "./multi-collector-harness.js";
import type { AddressInfo, Socket } from "node:net";

const CLIENT_ID = "9d8c7b6a5f4e3d2c1b0a99887766554433.access";
const CLIENT_SECRET = "fictional-access-secret-a1b2c3d4e5f60718293a4b5c6d7e8f90";
const WRONG_SECRET = "fictional-wrong-secret-0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const SOURCE = SourceId("notes-synth:access");

interface EdgeLog {
  admitted: string[];
  redirected: string[];
  forbidden: string[];
}

function verdict(req: IncomingMessage): "admit" | "redirect" | "forbid" {
  const id = req.headers["cf-access-client-id"];
  const secret = req.headers["cf-access-client-secret"];
  if (id === undefined && secret === undefined) return "redirect";
  return id === CLIENT_ID && secret === CLIENT_SECRET ? "admit" : "forbid";
}

/**
 * The stand-in edge. Its login page is served from its own origin under
 * `/cdn-cgi/access/login`, so a followed redirect never leaves the machine.
 */
function startAccessEdge(
  gatewayPort: number,
  log: EdgeLog,
): Promise<{ server: Server; url: string }> {
  const loginPath = "/cdn-cgi/access/login/omnesis.example.com";
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path.startsWith("/cdn-cgi/access/login")) {
      res.writeHead(200, { "content-type": "text/html", "cf-ray": "8f0e1d2c3b4a5968-SJC" });
      res.end("<html><body>Sign in</body></html>");
      return;
    }
    const decision = verdict(req);
    if (decision === "redirect") {
      log.redirected.push(path);
      res.writeHead(302, { location: `${loginPath}?redirect_url=${encodeURIComponent(path)}` });
      res.end();
      return;
    }
    if (decision === "forbid") {
      log.forbidden.push(path);
      res.writeHead(403, { "content-type": "text/html", "cf-ray": "8f0e1d2c3b4a5968-SJC" });
      res.end('<html><body>Forbidden <a href="/cdn-cgi/access/logout">Sign out</a></body></html>');
      return;
    }
    log.admitted.push(path);
    const headers: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: `localhost:${gatewayPort}`,
    };
    delete headers["cf-access-client-id"];
    delete headers["cf-access-client-secret"];
    const upstream = httpsRequest(
      {
        host: "localhost",
        port: gatewayPort,
        path,
        method: req.method,
        headers,
        rejectUnauthorized: false,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, {
          ...upstreamRes.headers,
          "cf-ray": "8f0e1d2c3b4a5968-SJC",
        });
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const path = req.url ?? "/";
    const decision = verdict(req);
    if (decision !== "admit") {
      (decision === "redirect" ? log.redirected : log.forbidden).push(path);
      socket.end(
        decision === "redirect"
          ? `HTTP/1.1 302 Found\r\nLocation: ${loginPath}\r\nContent-Length: 0\r\n\r\n`
          : `HTTP/1.1 403 Forbidden\r\ncf-ray: 8f0e1d2c3b4a5968-SJC\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    log.admitted.push(path);
    const upstream = tlsConnect(
      { host: "localhost", port: gatewayPort, servername: "localhost", rejectUnauthorized: false },
      () => {
        const lines = [`${req.method} ${path} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const name = req.rawHeaders[i]!;
          if (/^cf-access-client-/i.test(name)) continue;
          if (/^host$/i.test(name)) {
            lines.push(`Host: localhost:${gatewayPort}`);
            continue;
          }
          lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
        }
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      },
    );
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    ),
  );
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("a gateway behind Cloudflare Access", () => {
  const harness = new MultiCollectorHarness();
  const log: EdgeLog = { admitted: [], redirected: [], forbidden: [] };
  let edge: { server: Server; url: string };
  let machineDir: string;
  let pairingCode: string;

  const cli = (args: string[]) =>
    harness.runCli(args, {
      timeoutMs: 60_000,
      extraEnv: {
        OMNESIS_CONFIG_DIR: machineDir,
        OMNESIS_GATEWAY_URL: edge.url,
        OMNESIS_SECRET_STORE: "file",
        OMNESIS_TOKEN: "",
        OMNESIS_MDNS_DISABLE: "1",
      },
    });

  const setToken = async (secret: string) => {
    const secretFile = join(
      machineDir,
      "..",
      `secret-${createHash("sha256").update(secret).digest("hex").slice(0, 8)}`,
    );
    writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
    const set = await cli([
      "gateway",
      "access-token",
      "set",
      "--gateway-url",
      edge.url,
      "--id",
      CLIENT_ID,
      "--secret-file",
      secretFile,
    ]);
    expect(set.exitCode, set.stderr).toBe(0);
    expect(`${set.stdout}${set.stderr}`).not.toContain(secret);
  };

  beforeAll(async () => {
    await harness.start();
    edge = await startAccessEdge(harness.gatewayPort, log);
    machineDir = join(mkdtempSync(join(tmpdir(), "omnesis-access-machine-")), "config");
    pairingCode = (
      await harness.json<{ pairingCode: string }>("/admin/devices/pair", {
        method: "POST",
        body: JSON.stringify({ kind: "collector" }),
      })
    ).pairingCode;
  }, 120_000);

  afterAll(async () => {
    await resetGatewayAccessForTests();
    edge?.server.closeAllConnections?.();
    edge?.server.close();
    await harness.destroy();
    if (machineDir) rmSync(join(machineDir, ".."), { recursive: true, force: true });
  }, 30_000);

  test("pairing without a service token is refused by Access, in its own words", async () => {
    const run = await cli([
      "pair",
      pairingCode,
      "--gateway-url",
      edge.url,
      "--save",
      join(machineDir, "collector-token"),
    ]);
    expect(run.exitCode).not.toBe(0);
    const said = `${run.stdout}${run.stderr}`;
    expect(said).toContain("Cloudflare Access refused this machine");
    expect(said).toContain("no service token for it is configured here");
    expect(log.redirected).toContain("/devices/pair");
  }, 90_000);

  test("a wrong secret is named as Access refusing this machine's token, never echoed", async () => {
    await setToken(WRONG_SECRET);
    const run = await cli([
      "pair",
      pairingCode,
      "--gateway-url",
      edge.url,
      "--save",
      join(machineDir, "collector-token"),
    ]);
    expect(run.exitCode).not.toBe(0);
    const said = `${run.stdout}${run.stderr}`;
    expect(said).toContain("Cloudflare Access refused this machine's service token");
    expect(said).toContain(CLIENT_ID);
    expect(said).not.toContain(WRONG_SECRET);
    expect(log.forbidden).toContain("/devices/pair");
  }, 90_000);

  test("with the token, pairing, a sync push and the WebSocket all pass through", async () => {
    await setToken(CLIENT_SECRET);
    // The same code: neither refusal reached the gateway, so it is unspent.
    const pair = await cli([
      "pair",
      pairingCode,
      "--gateway-url",
      edge.url,
      "--save",
      join(machineDir, "collector-token"),
    ]);
    expect(pair.exitCode, `${pair.stdout}${pair.stderr}`).toBe(0);
    expect(log.admitted).toContain("/devices/pair");
    const token = readSecretTextFileSync(join(machineDir, "collector-token"), {
      configDir: machineDir,
    })!.trim();

    const saved = await readGatewayAccessCredentials(machineDir, {});
    expect(saved?.clientId).toBe(CLIENT_ID);
    await installGatewayAccess([edge.url], saved!);

    const ws = new GatewayWsClient(edge.url, token, {
      reconnectDelay: 100,
      capabilities: {
        hostname: "field-station.example.com",
        platform: "linux",
        hostableSourceTypes: ["notes-synth"] as never,
      },
    });
    ws.connect();
    try {
      await waitFor(() => ws.isAuthenticated());
      expect(log.admitted).toContain("/device/ws");

      const client = new HttpGatewayClient(edge.url, token);
      const registered = await client.bulkUpsertSources([
        { type: SourceType("notes-synth"), accountId: AccountId("access") },
      ]);
      expect(registered.errors).toEqual([]);
      const content = "A fictional field note pushed through the Access edge.";
      const document: DocumentInput = {
        providerId: ProviderId("notes-synth:access"),
        sourceId: SOURCE,
        externalId: "field-note-1",
        title: "Field note",
        content,
        contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        metadata: { documentType: "note" },
        sourceCreatedAt: "2026-01-01T00:00:00Z",
        sourceUpdatedAt: "2026-01-01T00:00:00Z",
      };
      await client.upsertDocuments([document]);
      await client.setSyncState(SOURCE, { cursor: "page-1" });
      expect(await client.getDocumentCount(SOURCE)).toBe(1);

      const direct = new HttpGatewayClient(harness.gatewayUrl, harness.bootstrapToken);
      expect(await direct.getDocumentCount(SOURCE)).toBe(1);
      expect(log.admitted).toEqual(
        expect.arrayContaining(["/documents", "/devices/sources/bulk-upsert"]),
      );
    } finally {
      ws.disconnect();
    }
  }, 120_000);

  test("a sync push with a revoked token is refused as Access, without retrying", async () => {
    await installGatewayAccess([edge.url], {
      clientId: CLIENT_ID,
      clientSecret: WRONG_SECRET,
      gatewayOrigin: edge.url,
    });
    const forbiddenBefore = log.forbidden.length;
    const client = new HttpGatewayClient(edge.url, "omn_unused");
    const err = await client.getConfig().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudflareAccessRefusedError);
    expect((err as Error).message).not.toContain(WRONG_SECRET);
    expect(log.forbidden.length - forbiddenBefore).toBe(1);
  }, 30_000);
});
