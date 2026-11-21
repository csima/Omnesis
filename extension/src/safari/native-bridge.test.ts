// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  createNativeFetch,
  parseNativeResponse,
  parseNativeStatus,
  readNativeStatus,
  SAFARI_GATEWAY_ORIGIN,
  type NativeMessage,
} from "./native-bridge.js";

const init = {
  method: "POST",
  headers: { authorization: "Bearer native", "content-type": "application/json" },
  body: '{"documents":[]}',
};

describe("native status", () => {
  it("reads a pairing and an absent one, and nothing else", () => {
    expect(
      parseNativeStatus({ paired: true, deviceId: "device-1", gatewayHost: "gateway.example.com" }),
    ).toEqual({ paired: true, deviceId: "device-1", gatewayHost: "gateway.example.com" });
    expect(parseNativeStatus({ paired: false })).toEqual({ paired: false });
    for (const raw of [
      null,
      "paired",
      {},
      { paired: true },
      { paired: true, deviceId: "", gatewayHost: "gateway.example.com" },
      { paired: true, deviceId: "device-1", gatewayHost: 7 },
      { paired: true, deviceId: "d".repeat(129), gatewayHost: "gateway.example.com" },
    ]) {
      expect(parseNativeStatus(raw)).toBeNull();
    }
  });

  it("reads as unknown when the app does not answer or throws", async () => {
    expect(await readNativeStatus(() => Promise.reject(new Error("no handler")))).toBeNull();
    expect(await readNativeStatus(() => new Promise(() => undefined), 10)).toBeNull();
  });
});

describe("native responses", () => {
  it("accepts a gateway answer and the three ways a request can fail", () => {
    expect(parseNativeResponse({ ok: true, status: 200, body: "{}", retryAfter: "30" })).toEqual({
      ok: true,
      status: 200,
      body: "{}",
      retryAfter: "30",
    });
    for (const reason of ["unpaired", "refused", "network"]) {
      expect(parseNativeResponse({ ok: false, reason })).toEqual({ ok: false, reason });
    }
    for (const raw of [
      undefined,
      { ok: true },
      { ok: true, status: 99, body: "" },
      { ok: true, status: 200.5, body: "" },
      { ok: true, status: 200, body: 4 },
      { ok: false, reason: "tired" },
    ]) {
      expect(parseNativeResponse(raw)).toBeNull();
    }
  });
});

describe("createNativeFetch", () => {
  it("sends the method, path and body, and never the caller's origin or headers", async () => {
    const sent: NativeMessage[] = [];
    const fetch = createNativeFetch((message) => {
      sent.push(message);
      return Promise.resolve({ ok: true, status: 200, body: '{"ingested":1}', retryAfter: "12" });
    });

    const response = await fetch(`${SAFARI_GATEWAY_ORIGIN}/documents`, init);

    expect(sent).toEqual([
      { type: "request", method: "POST", path: "/documents", body: '{"documents":[]}' },
    ]);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ingested":1}');
    expect(response.headers.get("Retry-After")).toBe("12");
    expect(response.headers.get("content-type")).toBeNull();
  });

  it("sends no body with a read", async () => {
    const sent: NativeMessage[] = [];
    const fetch = createNativeFetch((message) => {
      sent.push(message);
      return Promise.resolve({ ok: true, status: 200, body: "{}" });
    });
    await fetch(`${SAFARI_GATEWAY_ORIGIN}/web-capture-policy`, {
      method: "GET",
      headers: {},
      body: "",
    });
    expect(sent).toEqual([{ type: "request", method: "GET", path: "/web-capture-policy" }]);
  });

  it("reads an unpaired app as an unauthorized gateway and says so once", async () => {
    const onUnpaired = vi.fn();
    const fetch = createNativeFetch(() => Promise.resolve({ ok: false, reason: "unpaired" }), {
      onUnpaired,
    });
    expect((await fetch(`${SAFARI_GATEWAY_ORIGIN}/documents`, init)).status).toBe(401);
    expect(onUnpaired).toHaveBeenCalledTimes(1);
  });

  it("reads a request the app refuses as one the gateway would reject", async () => {
    const fetch = createNativeFetch(() => Promise.resolve({ ok: false, reason: "refused" }));
    expect((await fetch(`${SAFARI_GATEWAY_ORIGIN}/documents`, init)).status).toBe(400);
  });

  it("never asks the app for a request outside the contract", async () => {
    const sent: NativeMessage[] = [];
    const fetch = createNativeFetch((message) => {
      sent.push(message);
      return Promise.resolve({ ok: true, status: 200, body: "{}" });
    });
    for (const path of ["/admin/tokens", "/documents?sourceId=web", "/search"]) {
      expect((await fetch(`${SAFARI_GATEWAY_ORIGIN}${path}`, init)).status).toBe(400);
    }
    expect(sent).toEqual([]);
  });

  it("fails like a dropped connection when the gateway or the app cannot be reached", async () => {
    const offline = createNativeFetch(() => Promise.resolve({ ok: false, reason: "network" }));
    await expect(offline(`${SAFARI_GATEWAY_ORIGIN}/documents`, init)).rejects.toThrow(TypeError);

    const silent = createNativeFetch(() => new Promise(() => undefined), { timeoutMs: 10 });
    await expect(silent(`${SAFARI_GATEWAY_ORIGIN}/documents`, init)).rejects.toThrow(TypeError);

    const garbled = createNativeFetch(() => Promise.resolve("ok"));
    await expect(garbled(`${SAFARI_GATEWAY_ORIGIN}/documents`, init)).rejects.toThrow(TypeError);
  });

  it("stops waiting when the caller gives up", async () => {
    const controller = new AbortController();
    const fetch = createNativeFetch(() => new Promise(() => undefined));
    const pending = fetch(`${SAFARI_GATEWAY_ORIGIN}/documents`, {
      ...init,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(TypeError);
  });
});
