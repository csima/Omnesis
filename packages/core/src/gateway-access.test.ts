// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CloudflareAccessRefusedError,
  cloudflareAccessRefusal,
  enableGatewayAccess,
  gatewayAccessCredentialsPath,
  gatewayAccessOrigin,
  installGatewayAccess,
  isCloudflareAccessRefusedError,
  isCloudflareRefusalError,
  parseGatewayAccessCredentials,
  readGatewayAccessCredentials,
  removeGatewayAccessCredentials,
  resetGatewayAccessForTests,
  withGatewayAccessHeaders,
  writeGatewayAccessCredentials,
} from "./gateway-access.js";
import { fetchAllowingSlowResponse } from "./models/slow-response-fetch.js";
import { ensureInstallRootKey } from "./secret-store.js";
import { clearSecretFileKeyCacheForTests, isEncryptedSecretFile } from "./secret-file.js";
import type { AddressInfo } from "node:net";

const CLIENT_ID = "4f1c2d3e5a6b7c8d9e0f1a2b3c4d5e6f.access";
const CLIENT_SECRET = "s3cr3t-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab";
const GATEWAY = "https://omnesis.example.com";
const CREDENTIALS = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, gatewayOrigin: GATEWAY };
const ENV_GATEWAY = { OMNESIS_ACCESS_GATEWAY_URL: GATEWAY };

describe("parseGatewayAccessCredentials", () => {
  test("trims both values", () => {
    expect(
      parseGatewayAccessCredentials(` ${CLIENT_ID}\n`, `${CLIENT_SECRET}\n`, `${GATEWAY}/`),
    ).toEqual(CREDENTIALS);
  });

  test("refuses an empty or header-unsafe value without quoting it", () => {
    expect(() => parseGatewayAccessCredentials("", CLIENT_SECRET, GATEWAY)).toThrow(/client id/);
    expect(() => parseGatewayAccessCredentials(CLIENT_ID, "", GATEWAY)).toThrow(/client secret/);
    expect(() =>
      parseGatewayAccessCredentials(CLIENT_ID, CLIENT_SECRET, "http://omnesis.example.com"),
    ).toThrow(/gateway URL it is for/);
    const mangled = `${CLIENT_SECRET} trailing`;
    let message = "";
    try {
      parseGatewayAccessCredentials(CLIENT_ID, mangled, GATEWAY);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/client secret/);
    expect(message).not.toContain(CLIENT_SECRET);
    expect(() =>
      parseGatewayAccessCredentials(CLIENT_ID, "line\r\nInjected: 1", GATEWAY),
    ).toThrow();
  });
});

describe("reading the service token", () => {
  let dir: string;
  const previousStore = process.env.OMNESIS_SECRET_STORE;

  beforeEach(() => {
    clearSecretFileKeyCacheForTests();
    dir = mkdtempSync(join(tmpdir(), "omnesis-gateway-access-"));
    process.env.OMNESIS_SECRET_STORE = "file";
  });

  afterEach(() => {
    clearSecretFileKeyCacheForTests();
    rmSync(dir, { recursive: true, force: true });
    if (previousStore === undefined) delete process.env.OMNESIS_SECRET_STORE;
    else process.env.OMNESIS_SECRET_STORE = previousStore;
  });

  test("none is configured by default", async () => {
    expect(await readGatewayAccessCredentials(dir, {})).toBeNull();
  });

  test("from the environment, inline or from a file", async () => {
    expect(
      await readGatewayAccessCredentials(dir, {
        OMNESIS_ACCESS_CLIENT_ID: CLIENT_ID,
        OMNESIS_ACCESS_CLIENT_SECRET: CLIENT_SECRET,
        ...ENV_GATEWAY,
      }),
    ).toEqual({ ...CREDENTIALS, source: "env" });
    const secretFile = join(dir, "secret");
    writeFileSync(secretFile, `${CLIENT_SECRET}\n`);
    expect(
      await readGatewayAccessCredentials(dir, {
        OMNESIS_ACCESS_CLIENT_ID: CLIENT_ID,
        OMNESIS_ACCESS_CLIENT_SECRET_FILE: secretFile,
        ...ENV_GATEWAY,
      }),
    ).toEqual({ ...CREDENTIALS, source: "env" });
  });

  test("half a token in the environment is refused, naming what is missing", async () => {
    await expect(
      readGatewayAccessCredentials(dir, { OMNESIS_ACCESS_CLIENT_ID: CLIENT_ID }),
    ).rejects.toThrow(/OMNESIS_ACCESS_CLIENT_SECRET/);
    await expect(
      readGatewayAccessCredentials(dir, { OMNESIS_ACCESS_CLIENT_SECRET: CLIENT_SECRET }),
    ).rejects.toThrow(/OMNESIS_ACCESS_CLIENT_ID/);
    await expect(
      readGatewayAccessCredentials(dir, {
        OMNESIS_ACCESS_CLIENT_ID: CLIENT_ID,
        OMNESIS_ACCESS_CLIENT_SECRET: CLIENT_SECRET,
        OMNESIS_ACCESS_CLIENT_SECRET_FILE: join(dir, "secret"),
      }),
    ).rejects.toThrow(/not both/);
  });

  test("a saved token is an owner-only file without a root key", async () => {
    const saved = await writeGatewayAccessCredentials(dir, CREDENTIALS);
    expect(saved).toEqual({ path: gatewayAccessCredentialsPath(dir), encrypted: false });
    expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    expect(await readGatewayAccessCredentials(dir, {})).toEqual({
      ...CREDENTIALS,
      source: "file",
      path: saved.path,
    });
  });

  test("a saved token is sealed by the install root key, so the secret is not on disk", async () => {
    await ensureInstallRootKey({ backend: "file", configDir: dir });
    const saved = await writeGatewayAccessCredentials(dir, CREDENTIALS);
    expect(saved.encrypted).toBe(true);
    const raw = readFileSync(saved.path, "utf8");
    expect(isEncryptedSecretFile(raw)).toBe(true);
    expect(raw).not.toContain(CLIENT_SECRET);
    expect((await readGatewayAccessCredentials(dir, {}))?.clientSecret).toBe(CLIENT_SECRET);
  });

  test("the environment outranks the saved token", async () => {
    await writeGatewayAccessCredentials(dir, {
      clientId: "saved.access",
      clientSecret: "saved-secret",
      gatewayOrigin: GATEWAY,
    });
    const loaded = await readGatewayAccessCredentials(dir, {
      OMNESIS_ACCESS_CLIENT_ID: CLIENT_ID,
      OMNESIS_ACCESS_CLIENT_SECRET: CLIENT_SECRET,
      ...ENV_GATEWAY,
    });
    expect(loaded?.clientId).toBe(CLIENT_ID);
  });

  test("clear removes it, once", async () => {
    await writeGatewayAccessCredentials(dir, CREDENTIALS);
    expect(removeGatewayAccessCredentials(dir)).toBe(true);
    expect(removeGatewayAccessCredentials(dir)).toBe(false);
    expect(await readGatewayAccessCredentials(dir, {})).toBeNull();
  });
});

describe("gatewayAccessOrigin", () => {
  test("https anywhere and http only to loopback", () => {
    expect(gatewayAccessOrigin("https://omnesis.example.com/")).toBe("https://omnesis.example.com");
    expect(gatewayAccessOrigin("https://omnesis.example.com:443")).toBe(
      "https://omnesis.example.com",
    );
    expect(gatewayAccessOrigin("wss://omnesis.example.com/device/ws")).toBe(
      "https://omnesis.example.com",
    );
    expect(gatewayAccessOrigin("http://127.0.0.1:17641")).toBe("http://127.0.0.1:17641");
    expect(gatewayAccessOrigin("http://omnesis.example.com")).toBeNull();
    expect(gatewayAccessOrigin("not a url")).toBeNull();
  });
});

describe("withGatewayAccessHeaders", () => {
  test("adds both headers to every shape a dispatcher sees, replacing a caller's own", () => {
    const expected = {
      authorization: "Bearer device",
      "CF-Access-Client-Id": CLIENT_ID,
      "CF-Access-Client-Secret": CLIENT_SECRET,
    };
    expect(
      withGatewayAccessHeaders(
        { authorization: "Bearer device", "cf-access-client-id": "other" },
        CREDENTIALS,
      ),
    ).toEqual(expected);
    expect(withGatewayAccessHeaders(["authorization", "Bearer device"], CREDENTIALS)).toEqual(
      expected,
    );
    expect(withGatewayAccessHeaders([["authorization", "Bearer device"]], CREDENTIALS)).toEqual(
      expected,
    );
    expect(withGatewayAccessHeaders(undefined, CREDENTIALS)).toEqual({
      "CF-Access-Client-Id": CLIENT_ID,
      "CF-Access-Client-Secret": CLIENT_SECRET,
    });
  });
});

describe("the headers on the wire", () => {
  let gateway: Server;
  let elsewhere: Server;
  let gatewayUrl: string;
  let elsewhereUrl: string;
  const seen: Array<{ server: string; path: string; headers: IncomingHttpHeaders }> = [];

  function listen(server: Server): Promise<string> {
    return new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      ),
    );
  }

  beforeAll(async () => {
    elsewhere = createServer((req, res) => {
      seen.push({ server: "elsewhere", path: req.url ?? "", headers: req.headers });
      res.end("{}");
    });
    elsewhereUrl = await listen(elsewhere);
    gateway = createServer((req, res) => {
      seen.push({ server: "gateway", path: req.url ?? "", headers: req.headers });
      if (req.url === "/away") {
        res.writeHead(302, { location: `${elsewhereUrl}/landing` });
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    gateway.on("upgrade", (req, socket) => {
      seen.push({ server: "gateway", path: req.url ?? "", headers: req.headers });
      socket.destroy();
    });
    gatewayUrl = await listen(gateway);
    await installGatewayAccess([gatewayUrl], { ...CREDENTIALS, gatewayOrigin: gatewayUrl });
  });

  afterAll(async () => {
    await resetGatewayAccessForTests();
    gateway.close();
    elsewhere.close();
  });

  beforeEach(() => {
    seen.length = 0;
  });

  test("fetch to the gateway carries both headers", async () => {
    await (await fetch(`${gatewayUrl}/health`)).text();
    expect(seen[0]?.headers["cf-access-client-id"]).toBe(CLIENT_ID);
    expect(seen[0]?.headers["cf-access-client-secret"]).toBe(CLIENT_SECRET);
  });

  test("a request with a dispatcher of its own carries them too", async () => {
    await (
      await fetchAllowingSlowResponse(`${gatewayUrl}/inference/ocr`, { method: "POST" })
    ).text();
    expect(seen[0]?.headers["cf-access-client-secret"]).toBe(CLIENT_SECRET);
  });

  test("another origin never sees them, including a redirect away from the gateway", async () => {
    await (await fetch(`${elsewhereUrl}/direct`)).text();
    await (await fetch(`${gatewayUrl}/away`)).text();
    const other = seen.filter((entry) => entry.server === "elsewhere");
    expect(other.map((entry) => entry.path)).toEqual(["/direct", "/landing"]);
    for (const entry of other) {
      expect(entry.headers["cf-access-client-id"]).toBeUndefined();
      expect(entry.headers["cf-access-client-secret"]).toBeUndefined();
    }
  });

  test("the WebSocket upgrade carries both headers", async () => {
    const ws = new WebSocket(`${gatewayUrl.replace("http", "ws")}/device/ws`, ["omnesis.v1"]);
    await new Promise<void>((resolve) => {
      ws.addEventListener("error", () => resolve());
      ws.addEventListener("close", () => resolve());
    });
    const upgrade = seen.find((entry) => entry.path === "/device/ws");
    expect(upgrade?.headers.upgrade).toBe("websocket");
    expect(upgrade?.headers["cf-access-client-id"]).toBe(CLIENT_ID);
    expect(upgrade?.headers["cf-access-client-secret"]).toBe(CLIENT_SECRET);
  });

  test("a plain-http gateway elsewhere is never sent the secret", async () => {
    expect(
      await installGatewayAccess(["http://omnesis.example.com:7600"], {
        ...CREDENTIALS,
        gatewayOrigin: gatewayUrl,
      }),
    ).toEqual([]);
  });
});

describe("enableGatewayAccess", () => {
  afterEach(async () => {
    await resetGatewayAccessForTests();
  });

  test("does nothing without a token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-gateway-access-none-"));
    try {
      expect(await enableGatewayAccess(["https://omnesis.example.com"], dir, {})).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never logs the secret", async () => {
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
    try {
      await installGatewayAccess(
        ["https://omnesis.example.com", "http://omnesis.example.com:7600"],
        CREDENTIALS,
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(written.join("\n")).toContain("Not sending the Cloudflare Access service token");
    expect(written.join("\n")).not.toContain(CLIENT_SECRET);
  });

  test("reports the client id and the origins, never the secret", async () => {
    const result = await enableGatewayAccess(["https://omnesis.example.com"], tmpdir(), {
      OMNESIS_ACCESS_CLIENT_ID: CLIENT_ID,
      OMNESIS_ACCESS_CLIENT_SECRET: CLIENT_SECRET,
      ...ENV_GATEWAY,
    });
    expect(result).toEqual({
      clientId: CLIENT_ID,
      source: "env",
      origins: ["https://omnesis.example.com"],
    });
    expect(JSON.stringify(result)).not.toContain(CLIENT_SECRET);
  });
});

describe("cloudflareAccessRefusal", () => {
  const url = "https://omnesis.example.com/health";
  const response = (status: number, headers: Record<string, string>, extra = {}) => ({
    status,
    headers: new Headers(headers),
    ...extra,
  });
  const ACCESS_MARK = { "cf-ray": "8f0e", "cf-access-domain": "omnesis.example.com" };

  afterEach(async () => {
    await resetGatewayAccessForTests();
  });

  test("a redirect to the team's Access login page", async () => {
    const refusal = await cloudflareAccessRefusal(
      url,
      response(302, {
        location: "https://fictional-team.cloudflareaccess.com/cdn-cgi/access/login/omnesis",
      }),
    );
    expect(refusal).toBeInstanceOf(CloudflareAccessRefusedError);
    expect(refusal?.message).toContain("Cloudflare Access refused this machine");
  });

  test("the login page a followed redirect landed on", async () => {
    expect(
      await cloudflareAccessRefusal(
        url,
        response(
          200,
          { "content-type": "text/html" },
          {
            redirected: true,
            url: "https://fictional-team.cloudflareaccess.com/cdn-cgi/access/login/omnesis",
          },
        ),
      ),
    ).not.toBeNull();
  });

  test("a 403 Cloudflare answered itself, not the gateway's JSON 403", async () => {
    expect(
      await cloudflareAccessRefusal(
        url,
        response(403, { ...ACCESS_MARK, "content-type": "text/html" }),
      ),
    ).toBeInstanceOf(CloudflareAccessRefusedError);
    expect(
      await cloudflareAccessRefusal(
        url,
        response(403, { "cf-ray": "8f0e", "content-type": "application/json" }),
      ),
    ).toBeNull();
    expect(
      await cloudflareAccessRefusal(url, response(403, { "content-type": "text/plain" })),
    ).toBeNull();
    expect(
      await cloudflareAccessRefusal(url, response(200, { "content-type": "application/json" })),
    ).toBeNull();
  });

  test("names the service token it refused by client id, never by secret", async () => {
    await installGatewayAccess(["https://omnesis.example.com"], CREDENTIALS);
    const refusal = await cloudflareAccessRefusal(url, response(403, ACCESS_MARK));
    expect(refusal?.message).toContain("Cloudflare Access refused this machine's service token");
    expect(refusal?.message).toContain(CLIENT_ID);
    expect(refusal?.message).not.toContain(CLIENT_SECRET);
    expect(isCloudflareAccessRefusedError(new Error("wrapped", { cause: refusal }))).toBe(true);
    expect(isCloudflareRefusalError(new Error("wrapped", { cause: refusal }))).toBe(true);
  });

  test("without a token it says none is configured", async () => {
    const refusal = await cloudflareAccessRefusal(url, response(403, ACCESS_MARK));
    expect(refusal?.message).toContain("no service token for it is configured here");
    expect(refusal?.message).toContain("omnesis gateway access-token set");
  });
});
