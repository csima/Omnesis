// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The service token stays with the gateway it was issued for: it is bound to
 * one origin, never crosses a proxy in the clear, never rides a TLS
 * connection whose certificate goes unchecked, never outlives its read in the
 * environment, and a Cloudflare refusal is named for what it is.
 */

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  CloudflareAccessRefusedError,
  cloudflareAccessRefusal,
  installGatewayAccess,
  readGatewayAccessCredentials,
  resetGatewayAccessForTests,
} from "./gateway-access.js";
import type { AddressInfo } from "node:net";

const CLIENT_ID = "6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d.access";
const CLIENT_SECRET = "bound-secret-00112233445566778899aabbccddeeff00112233";

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
}

function listen(seen: Seen[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", headers: req.headers });
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
    ),
  );
}

function captureOutput(): { text: () => string; restore: () => void } {
  const written: string[] = [];
  const capture = (...args: unknown[]) => {
    written.push(args.map(String).join(" "));
    return true;
  };
  const spies = [
    vi.spyOn(console, "log").mockImplementation(capture),
    vi.spyOn(console, "info").mockImplementation(capture),
    vi.spyOn(console, "warn").mockImplementation(capture),
    vi.spyOn(console, "error").mockImplementation(capture),
    vi.spyOn(process.stdout, "write").mockImplementation(capture),
    vi.spyOn(process.stderr, "write").mockImplementation(capture),
  ];
  return {
    text: () => written.join("\n"),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await resetGatewayAccessForTests();
});

describe("the token is bound to one gateway", () => {
  const boundSeen: Seen[] = [];
  const otherSeen: Seen[] = [];
  let bound: { server: Server; url: string };
  let other: { server: Server; url: string };

  beforeAll(async () => {
    bound = await listen(boundSeen);
    other = await listen(otherSeen);
  });

  afterAll(() => {
    bound.server.close();
    other.server.close();
  });

  test("another gateway URL is skipped, with a warning, and never sent the secret", async () => {
    const output = captureOutput();
    let installed: string[];
    try {
      installed = await installGatewayAccess(["https://other.example.com", other.url, bound.url], {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        gatewayOrigin: bound.url,
      });
    } finally {
      output.restore();
    }
    expect(installed).toEqual([bound.url]);
    // A loopback URL that is not the bound one is skipped quietly: every CLI on
    // a collector machine dials one by default.
    expect(output.text()).toContain(
      "Not sending the Cloudflare Access service token to https://other.example.com/: it is bound to",
    );
    await (await fetch(`${other.url}/health`)).text();
    await (await fetch(`${bound.url}/health`)).text();
    expect(otherSeen.at(-1)?.headers["cf-access-client-secret"]).toBeUndefined();
    expect(boundSeen.at(-1)?.headers["cf-access-client-secret"]).toBe(CLIENT_SECRET);
  });

  test("the environment form names its gateway too", async () => {
    await expect(
      readGatewayAccessCredentials(tmpdir(), {
        OMNESIS_ACCESS_CLIENT_ID: CLIENT_ID,
        OMNESIS_ACCESS_CLIENT_SECRET: CLIENT_SECRET,
      }),
    ).rejects.toThrow(/OMNESIS_ACCESS_GATEWAY_URL/);
    expect(
      await readGatewayAccessCredentials(tmpdir(), {
        OMNESIS_ACCESS_CLIENT_ID: CLIENT_ID,
        OMNESIS_ACCESS_CLIENT_SECRET: CLIENT_SECRET,
        OMNESIS_ACCESS_GATEWAY_URL: "https://omnesis.example.com/some/path",
      }),
    ).toMatchObject({ gatewayOrigin: "https://omnesis.example.com" });
  });

  test("the log line for a skipped URL carries no userinfo", async () => {
    const output = captureOutput();
    try {
      await installGatewayAccess(["http://maya:hunter2-pw@other.example.com"], {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        gatewayOrigin: "https://omnesis.example.com",
      });
    } finally {
      output.restore();
    }
    expect(output.text()).toContain("other.example.com");
    expect(output.text()).not.toContain("hunter2-pw");
    expect(output.text()).not.toContain("maya");
  });
});

describe("a loopback gateway never goes through an environment proxy", () => {
  const gatewaySeen: Seen[] = [];
  const proxySeen: Seen[] = [];
  let gateway: { server: Server; url: string };
  let proxy: { server: Server; url: string };

  beforeAll(async () => {
    gateway = await listen(gatewaySeen);
    proxy = await listen(proxySeen);
  });

  afterAll(() => {
    gateway.server.close();
    proxy.server.close();
  });

  test("the secret reaches the gateway directly, not the proxy", async () => {
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    vi.stubEnv("HTTP_PROXY", proxy.url);
    vi.stubEnv("http_proxy", proxy.url);
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    await installGatewayAccess([gateway.url], {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      gatewayOrigin: gateway.url,
    });
    await (await fetch(`${gateway.url}/health`)).text();
    for (const entry of proxySeen) {
      expect(entry.headers["cf-access-client-secret"]).toBeUndefined();
    }
    expect(gatewaySeen.at(-1)?.headers["cf-access-client-secret"]).toBe(CLIENT_SECRET);
  });
});

describe("TLS verification must be on", () => {
  test("the token is not installed for an https gateway when certificates go unchecked", async () => {
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    await expect(
      installGatewayAccess(["https://omnesis.example.com"], {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        gatewayOrigin: "https://omnesis.example.com",
      }),
    ).rejects.toThrow(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });
});

describe("an inline secret leaves the environment once read", () => {
  test("it is removed from process.env, and a second read still has it", async () => {
    vi.stubEnv("OMNESIS_ACCESS_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("OMNESIS_ACCESS_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("OMNESIS_ACCESS_GATEWAY_URL", "https://omnesis.example.com");
    const first = await readGatewayAccessCredentials(tmpdir());
    expect(first?.clientSecret).toBe(CLIENT_SECRET);
    expect(process.env.OMNESIS_ACCESS_CLIENT_SECRET).toBeUndefined();
    const second = await readGatewayAccessCredentials(tmpdir());
    expect(second?.clientSecret).toBe(CLIENT_SECRET);
  });
});

describe("a Cloudflare refusal names what refused it", () => {
  const url = "https://omnesis.example.com/health";
  const html = (body: string, headers: Record<string, string>) =>
    new Response(body, { status: 403, headers: { "content-type": "text/html", ...headers } });

  test("a firewall block is not blamed on the service token", async () => {
    const refusal = await cloudflareAccessRefusal(
      url,
      html("<html>Sorry, you have been blocked</html>", { "cf-ray": "8f0e1d2c3b4a5968-SJC" }),
    );
    expect(refusal).not.toBeInstanceOf(CloudflareAccessRefusedError);
    expect(refusal?.message).toContain("Cloudflare blocked the request (ray 8f0e1d2c3b4a5968-SJC)");
    expect(refusal?.message).not.toContain("service token");
  });

  test("an Access page or header is named as Access", async () => {
    expect(
      await cloudflareAccessRefusal(
        url,
        html('<form action="/cdn-cgi/access/login/omnesis.example.com">', { "cf-ray": "8f0e" }),
      ),
    ).toBeInstanceOf(CloudflareAccessRefusedError);
    expect(
      await cloudflareAccessRefusal(
        url,
        html("Forbidden", { "cf-ray": "8f0e", "cf-access-domain": "omnesis.example.com" }),
      ),
    ).toBeInstanceOf(CloudflareAccessRefusedError);
  });
});
