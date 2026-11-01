// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A gateway request never follows a redirect: a 307 or 308 would resend the
 * request, body and all, to whatever origin it names.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";
import { AccountId, SourceType } from "@omnesis/types";
import { HttpGatewayClient } from "./http-gateway-client.js";
import type { AddressInfo } from "node:net";

const received: string[] = [];
let gateway: Server;
let elsewhere: Server;
let gatewayUrl: string;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

beforeAll(async () => {
  elsewhere = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      received.push(`${req.method} ${req.url} ${body}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ count: 1, sources: [], errors: [] }));
    });
  });
  const elsewhereUrl = await listen(elsewhere);
  gateway = createServer((req, res) => {
    req.resume();
    res.writeHead(307, { location: `${elsewhereUrl}${req.url}` });
    res.end();
  });
  gatewayUrl = await listen(gateway);
});

afterAll(() => {
  gateway.close();
  elsewhere.close();
});

test("a 307 from the gateway is an error, and the body goes nowhere else", async () => {
  const client = new HttpGatewayClient(gatewayUrl, "omn_fictional_device_token");
  await expect(
    client.bulkUpsertSources([{ type: SourceType("notes-synth"), accountId: AccountId("a") }]),
  ).rejects.toThrow(/307/);
  expect(received).toEqual([]);
});
