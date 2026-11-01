// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway client behind Cloudflare Access: a stand-in for the Access edge
 * that turns away any request, WebSocket upgrade included, without the
 * service token's two headers, in front of a stand-in gateway.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import {
  CloudflareAccessRefusedError,
  installGatewayAccess,
  isWsCommand,
  isWsEnvelope,
  makeResponseOk,
  resetGatewayAccessForTests,
} from "@omnesis/core";
import { GatewayWsClient } from "./gateway-ws-client.js";
import { HttpGatewayClient } from "./http-gateway-client.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const CLIENT_ID = "0a1b2c3d4e5f60718293a4b5c6d7e8f9.access";
const CLIENT_SECRET = "fictional-secret-9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const DEVICE_TOKEN = "omn_fictional_device_token";

let server: Server;
let gatewayUrl: string;
const admitted: string[] = [];
const refused: string[] = [];

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (
      c.req.header("cf-access-client-id") !== CLIENT_ID ||
      c.req.header("cf-access-client-secret") !== CLIENT_SECRET
    ) {
      refused.push(path);
      return c.html("<html><body>Forbidden</body></html>", 403, {
        "cf-ray": "8f0e1d2c3b4a5968-SJC",
      });
    }
    admitted.push(path);
    await next();
    return undefined;
  });
  app.get("/config", (c) => c.json({ config: {}, version: 7 }));
  app.get(
    "/device/ws",
    upgradeWebSocket(() => ({
      onMessage(e, ws) {
        const envelope = JSON.parse(String(e.data));
        if (isWsEnvelope(envelope) && isWsCommand(envelope) && envelope.type === "hello") {
          ws.send(
            JSON.stringify(
              makeResponseOk(envelope.id, {
                deviceId: "dev-1",
                scopes: ["write:*"],
                deviceName: "field-station",
                deviceKind: "collector",
                protocolVersion: 1,
              }),
            ),
          );
        }
      },
    })),
  );
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
  injectWebSocket(server);
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", () => resolve());
  });
  gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  admitted.length = 0;
  refused.length = 0;
  vi.unstubAllGlobals();
  await resetGatewayAccessForTests();
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
});

describe("HttpGatewayClient behind Cloudflare Access", () => {
  test("sends the service token with every request", async () => {
    await installGatewayAccess([gatewayUrl], { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const client = new HttpGatewayClient(gatewayUrl, DEVICE_TOKEN);
    await expect(client.getConfig()).resolves.toEqual({ config: {}, version: 7 });
    expect(admitted).toEqual(["/config"]);
  });

  test("a refusal is named as Access refusing this machine, once, and without the secret", async () => {
    await installGatewayAccess([gatewayUrl], { clientId: CLIENT_ID, clientSecret: "wrong-secret" });
    const client = new HttpGatewayClient(gatewayUrl, DEVICE_TOKEN);
    const err = await client.getConfig().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudflareAccessRefusedError);
    expect((err as Error).message).toContain(
      "Cloudflare Access refused this machine's service token",
    );
    expect((err as Error).message).toContain(CLIENT_ID);
    expect((err as Error).message).not.toContain("wrong-secret");
    expect(refused).toEqual(["/config"]);
  });

  test("a followed redirect to the Access login page is a refusal, not the gateway's answer", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: true,
        status: 200,
        redirected: true,
        url: "https://fictional-team.cloudflareaccess.com/cdn-cgi/access/login/omnesis.example.com",
        headers: new Headers({ "content-type": "text/html" }),
        body: null,
        json: () => Promise.reject(new SyntaxError("Unexpected token '<'")),
        text: () => Promise.resolve("<html></html>"),
      }),
    );
    const client = new HttpGatewayClient("https://omnesis.example.com", DEVICE_TOKEN);
    await expect(client.getConfig()).rejects.toThrow(
      /Cloudflare Access refused this machine for https:\/\/omnesis\.example\.com: .*no service token is configured/,
    );
  });
});

describe("GatewayWsClient behind Cloudflare Access", () => {
  test("the WebSocket upgrade carries the service token, so the hello is answered", async () => {
    await installGatewayAccess([gatewayUrl], { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const client = new GatewayWsClient(gatewayUrl, DEVICE_TOKEN, { reconnectDelay: 50 });
    client.connect();
    try {
      await waitFor(() => client.isAuthenticated());
      expect(admitted).toContain("/device/ws");
      expect(refused).toEqual([]);
    } finally {
      client.disconnect();
    }
  });

  test("without it the upgrade is turned away", async () => {
    const client = new GatewayWsClient(gatewayUrl, DEVICE_TOKEN, { reconnectDelay: 50 });
    client.connect();
    try {
      await waitFor(() => refused.includes("/device/ws"));
      expect(client.isAuthenticated()).toBe(false);
    } finally {
      client.disconnect();
    }
  });
});
