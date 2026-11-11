// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { connect } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { attachClientErrorResponses } from "./client-error.js";
import type { AddressInfo } from "node:net";

let server: ServerType | undefined;

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

async function listen(): Promise<number> {
  const app = new Hono();
  app.post("/echo", async (c) => c.json(await c.req.json()));
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  attachClientErrorResponses(server);
  await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
  return (server.address() as AddressInfo).port;
}

/** Send raw bytes, close our side, and collect whatever comes back. */
function exchange(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(request);
      socket.end();
    });
    let received = "";
    socket.on("data", (chunk) => (received += chunk.toString()));
    socket.on("close", () => resolve(received));
    // A server that answers before reading everything resets the rest; the
    // answer it already sent is what counts.
    socket.on("error", (err) => (received ? resolve(received) : reject(err)));
  });
}

describe("attachClientErrorResponses", () => {
  test("a body cut off by the client closing is a retryable 408, not a bare 400", async () => {
    // What a client suspended mid-upload, or a proxy abandoning it, leaves the
    // server with: a declared length, part of the bytes, then end of stream.
    const port = await listen();
    const response = await exchange(
      port,
      "POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n" +
        'Content-Length: 1000\r\n\r\n{"x":4',
    );
    expect(response.startsWith("HTTP/1.1 408 ")).toBe(true);
    expect(response).toContain('"code":"REQUEST_BODY_INCOMPLETE"');
  });

  test("a request that is not HTTP keeps Node's 400", async () => {
    const port = await listen();
    const response = await exchange(port, "NOT HTTP AT ALL\r\n\r\n");
    expect(response.startsWith("HTTP/1.1 400 ")).toBe(true);
  });

  test("oversized headers keep Node's 431", async () => {
    const port = await listen();
    const response = await exchange(
      port,
      `GET / HTTP/1.1\r\nHost: localhost\r\nX-Big: ${"a".repeat(64 * 1024)}\r\n\r\n`,
    );
    expect(response.startsWith("HTTP/1.1 431 ")).toBe(true);
  });

  test("a complete request is untouched", async () => {
    const port = await listen();
    const response = await exchange(
      port,
      "POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n" +
        'Connection: close\r\nContent-Length: 7\r\n\r\n{"x":4}',
    );
    expect(response.startsWith("HTTP/1.1 200 ")).toBe(true);
    expect(response).toContain('{"x":4}');
  });
});
