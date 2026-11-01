// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { gatewayFetch } from "./utils.js";
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
    received.push(`${req.method} ${req.url}`);
    req.resume();
    res.end("{}");
  });
  const elsewhereUrl = await listen(elsewhere);
  gateway = createServer((req, res) => {
    req.resume();
    res.writeHead(308, { location: `${elsewhereUrl}${req.url}` });
    res.end();
  });
  gatewayUrl = await listen(gateway);
});

afterAll(() => {
  gateway.close();
  elsewhere.close();
});

test("the CLI does not follow a gateway's redirect with its request", async () => {
  vi.stubEnv("OMNESIS_TOKEN", `omn_${"a".repeat(32)}`);
  const res = await gatewayFetch(`${gatewayUrl}/admin/config`, {
    method: "POST",
    body: JSON.stringify({ fictional: true }),
  });
  expect(res.status).toBe(308);
  expect(received).toEqual([]);
});
