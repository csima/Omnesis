// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  pair,
  PushClient,
  buildWebPageDocument,
  type DurableStore,
  type FetchLike,
} from "@omnesis/extension";
import {
  createSafariBackground,
  isAllowedNativeRequest,
  SAFARI_GATEWAY_ORIGIN,
  SAFARI_PROFILE_LABEL,
  type NativeMessage,
  type SafariBackground,
  type SafariMessageSender,
  type SafariPopupAck,
  type SafariStorageArea,
} from "@omnesis/extension/safari";
import { gatewayLogTail } from "./gateway-request.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

/**
 * Safari capture on an iPhone, end to end against a spawned gateway.
 *
 * On the phone, the extension holds no gateway address and no credential: its
 * background asks the iPhone app to make each request. This suite runs the
 * real Safari background under Node and stands in for the app with the same
 * three duties the app's extension handler has — report the pairing, refuse
 * anything outside the request contract, and attach the app's web-only
 * credential — so what is proved is the wire the phone will speak:
 *
 *   (1) a paired iPhone mints its Safari credential as a `write:web` token on
 *       its own device, and that token can neither read nor administer;
 *   (2) the first page read in Safari lands as a searchable `web` document and
 *       a `page_visits` row, labelled with the phone and "Safari";
 *   (3) that first push registers the `web` source, owned by the iPhone, as a
 *       push-based source, and a resync of it is refused — nothing could
 *       fetch the pages again;
 *   (4) an exclusion and a pause made from the Safari popup are the gateway's
 *       own capture settings, and stop capture in Safari at once;
 *   (5) a desktop browser capturing the same page afterwards updates the one
 *       document rather than adding a second;
 *   (6) unpairing in the app leaves Safari with no pairing and nothing queued.
 *
 * All pages are invented (example.org hosts, fictional text).
 */

let gatewayLogPath: string | undefined;

const nodeFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.method === "GET" ? undefined : init.body,
  });
  if (res.status >= 500) {
    process.stderr.write(
      `${init.method} ${url} → ${res.status}${gatewayLogTail(gatewayLogPath)}\n`,
    );
  }
  return {
    status: res.status,
    headers: { get: (name: string) => res.headers.get(name) },
    text: () => res.text(),
  };
};

class MemoryStorage implements SafariStorageArea {
  readonly data = new Map<string, unknown>();
  get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const wanted = keys === null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const key of wanted) if (this.data.has(key)) out[key] = this.data.get(key);
    return Promise.resolve(out);
  }
  set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data.set(key, value);
    return Promise.resolve();
  }
  remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key);
    return Promise.resolve();
  }
}

class MemoryStore implements DurableStore {
  private readonly data = new Map<string, string>();
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.data.get(key));
  }
  set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const RUNTIME_ID = "safari-extension-e2e";
const page: SafariMessageSender = { id: RUNTIME_ID, tab: { id: 1, incognito: false } };
const POPUP_URL = "safari-web-extension://e2e/popup.html";
const popup: SafariMessageSender = { id: RUNTIME_ID, url: POPUP_URL };

describe("Safari capture through the iPhone app (spawned gateway)", () => {
  let harness: SyntheticE2EHarness;
  let gatewayUrl: string;
  /** The gateway address the app holds; the extension never sees it. */
  let appGateway: string;
  let phone: { id: string; token: string };
  let safariToken: string;
  let appPaired = true;
  let storage: MemoryStorage;
  let background: SafariBackground;
  const refusedByApp: string[] = [];

  /** What the app's extension handler does with one message from Safari. */
  const sendNative = async (message: NativeMessage): Promise<unknown> => {
    if (message.type === "status") {
      return appPaired
        ? { paired: true, deviceId: phone.id, gatewayHost: new URL(gatewayUrl).hostname }
        : { paired: false };
    }
    if (!appPaired || message.deviceId !== phone.id) return { ok: false, reason: "unpaired" };
    if (!isAllowedNativeRequest(message.method, message.path)) {
      refusedByApp.push(`${message.method} ${message.path}`);
      return { ok: false, reason: "refused" };
    }
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await nodeFetch(`${appGateway}${message.path}`, {
        method: message.method,
        headers: { "content-type": "application/json", authorization: `Bearer ${safariToken}` },
        body: message.body ?? "",
      });
    } catch {
      return { ok: false, reason: "network" };
    }
    const retryAfter = res.headers.get("retry-after");
    return {
      ok: true,
      status: res.status,
      body: await res.text(),
      ...(retryAfter ? { retryAfter } : {}),
    };
  };

  function ask<T>(message: unknown, sender: SafariMessageSender): Promise<T> {
    return new Promise((resolve, reject) => {
      const handled = background.handleMessage(message, sender, (response) =>
        resolve(response as T),
      );
      if (!handled) reject(new Error(`the background ignored ${JSON.stringify(message)}`));
    });
  }

  /** A page Safari's content script finished reading, as it hands it to the background. */
  async function read(url: string, title: string, text: string): Promise<{ accepted: boolean }> {
    const ack = await ask<{ ok: boolean; accepted?: boolean }>(
      {
        type: "capture",
        emission: {
          kind: "visit",
          normalizedUrl: url,
          title,
          text,
          contentHash: await sha256(text),
          visitedAt: new Date().toISOString(),
          dwellMs: 9100,
          contentChanged: true,
        },
        handoffKey: `omnesis.capture.pending.v1.e2e.visit.${await sha256(url)}`,
        pairingId: await sha256(`${SAFARI_GATEWAY_ORIGIN}\0${phone.id}`),
      },
      page,
    );
    expect(ack.ok, "the background took the hand-off").toBe(true);
    return { accepted: ack.accepted === true };
  }

  async function webDocCount(): Promise<number> {
    return ((await harness.gatewayJson("/documents/count/web")) as { count: number }).count;
  }

  async function untilWebDocCount(expected: number): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const count = await webDocCount();
      if (count === expected) return;
      if (Date.now() > deadline) {
        throw new Error(`web holds ${count} documents, expected ${expected}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable" });
    await harness.start();
    gatewayUrl = harness.gatewayUrl;
    appGateway = gatewayUrl;
    gatewayLogPath = harness.getGatewayLogPath();

    const minted = (await harness.gatewayJson("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "ios" }),
    })) as { pairingCode: string };
    const redeemed = await fetch(`${gatewayUrl}/devices/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairingCode: minted.pairingCode,
        capabilities: {
          platform: "ios",
          installId: "fictional-install-safari",
          suggestedName: "Maya's iPhone",
        },
      }),
    });
    expect(redeemed.status, "the iPhone pairs").toBe(200);
    const body = (await redeemed.json()) as { device: { id: string }; token: string };
    phone = { id: body.device.id, token: body.token };

    storage = new MemoryStorage();
    background = createSafariBackground({
      storage,
      sendNative,
      runtimeId: RUNTIME_ID,
      popupUrl: POPUP_URL,
    });
  }, 180000);

  afterAll(async () => {
    await harness.destroy();
  }, 15000);

  test("(1) the iPhone mints a web-only credential that can neither read nor administer", async () => {
    const res = await fetch(`${gatewayUrl}/admin/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${phone.token}` },
      body: JSON.stringify({ deviceId: phone.id, scopes: ["write:web"], name: "safari" }),
    });
    expect(res.status).toBe(200);
    const minted = (await res.json()) as { token: string; deviceId: string; scopes: string[] };
    expect(minted).toMatchObject({ deviceId: phone.id, scopes: ["write:web"] });
    safariToken = minted.token;

    const withSafari = { authorization: `Bearer ${safariToken}` };
    expect((await fetch(`${gatewayUrl}/documents/count/web`, { headers: withSafari })).status).toBe(
      403,
    );
    expect((await fetch(`${gatewayUrl}/admin/sources`, { headers: withSafari })).status).toBe(403);
    const mintMore = await fetch(`${gatewayUrl}/admin/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", ...withSafari },
      body: JSON.stringify({ deviceId: phone.id, scopes: ["admin"], name: "escalation" }),
    });
    expect(mintMore.status).toBe(403);
  });

  test("(2) a page read in Safari lands as a searchable document and a visit", async () => {
    await background.start();
    const before = await webDocCount();
    const url = "https://trails.example.org/ridge-route";

    expect(
      await read(url, "Ridge route conditions", "Larkspur ridge is clear to the saddle."),
    ).toEqual({ accepted: true });
    await untilWebDocCount(before + 1);

    const found = (await harness.gatewayJson(
      `/documents/search?q=${encodeURIComponent("Larkspur ridge")}&limit=50`,
    )) as { results?: Array<{ id: string; source_id: string }> };
    const doc = found.results?.find((d) => d.source_id === "web");
    expect(doc, "the page is found as a web document").toBeDefined();
    const stored = (await harness.gatewayJson(`/documents/${doc!.id}`)) as { metadata: string };
    expect(JSON.parse(stored.metadata)).toMatchObject({
      documentType: "webpage",
      sourceUrl: url,
      extra: { browserDeviceId: phone.id, browserProfileLabel: SAFARI_PROFILE_LABEL },
    });

    const visits = (await harness.gatewayJson("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({
        sql: `SELECT dwell_ms, browser_device_id, browser_profile_label FROM page_visits WHERE url = '${url}'`,
      }),
    })) as { rows: unknown[][] };
    expect(visits.rows).toEqual([[9100, phone.id, SAFARI_PROFILE_LABEL]]);
    expect(refusedByApp, "Safari asked for nothing outside the contract").toEqual([]);
  });

  test("(3) the first push registered web to the iPhone, and it cannot be resynced", async () => {
    const listed = (await harness.gatewayJson("/admin/sources")) as {
      items: Array<{ id: string; deviceId: string; pushBased: boolean }>;
    };
    expect(listed.items.find((source) => source.id === "web")).toMatchObject({
      deviceId: phone.id,
      pushBased: true,
    });

    const before = await webDocCount();
    const res = await fetch(`${gatewayUrl}/admin/sources/web/resync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${phone.token}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code?: string }).code).toBe("RESYNC_PUSH_ONLY");
    expect(await webDocCount(), "nothing was wiped").toBe(before);
  });

  test("(4) an exclusion and a pause from the Safari popup are the gateway's settings", async () => {
    const excluded = await ask<SafariPopupAck>(
      { type: "safari-exclude", domain: "forum.example.net" },
      popup,
    );
    expect(excluded).toMatchObject({
      ok: true,
      status: { excludedDomains: ["forum.example.net"] },
    });
    const policy = (await harness.gatewayJson("/web-capture-policy")) as {
      excludedDomains: string[];
      pause: { until: number | null } | null;
    };
    expect(policy.excludedDomains).toEqual(["forum.example.net"]);

    const before = await webDocCount();
    expect(
      await read("https://forum.example.net/thread/41", "Thread", "Never leaves the phone."),
    ).toEqual({ accepted: false });

    expect(
      await ask<SafariPopupAck>({ type: "safari-set-pause", until: null }, popup),
    ).toMatchObject({ ok: true, status: { paused: true } });
    expect(
      ((await harness.gatewayJson("/web-capture-policy")) as { pause: unknown }).pause,
    ).toEqual({ until: null });
    expect(
      await read("https://trails.example.org/lake-loop", "Lake loop", "Paused, so not captured."),
    ).toEqual({ accepted: false });

    expect(await ask<SafariPopupAck>({ type: "safari-resume" }, popup)).toMatchObject({
      ok: true,
      status: { paused: false },
    });
    await ask<SafariPopupAck>({ type: "safari-include", domain: "forum.example.net" }, popup);
    expect(await webDocCount(), "neither refused page reached the gateway").toBe(before);
  });

  test("(5) a desktop browser reading the same page updates the one document", async () => {
    const before = await webDocCount();
    const minted = (await harness.gatewayJson("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ name: "Desktop browser (E2E)", kind: "browser" }),
    })) as { pairingCode: string };
    const desktop = await pair(gatewayUrl, minted.pairingCode, nodeFetch, "Personal");
    const text = "Larkspur ridge is clear to the saddle. Updated at noon.";
    const client = new PushClient({
      gatewayUrl,
      token: desktop.token,
      fetch: nodeFetch,
      store: new MemoryStore(),
    });
    await client.enqueueDocument(
      await buildWebPageDocument({
        normalizedUrl: "https://trails.example.org/ridge-route",
        title: "Ridge route conditions",
        text,
        contentHash: await sha256(text),
        visitedAt: new Date().toISOString(),
        browserProfile: { deviceId: desktop.device.id, label: "Personal" },
      }),
    );
    expect(await client.drain()).toMatchObject({ delivered: 1, retained: 0, dropped: 0 });
    expect(await webDocCount(), "the same page is one document").toBe(before);

    const listed = (await harness.gatewayJson("/admin/sources")) as {
      items: Array<{ id: string; deviceId: string }>;
    };
    expect(listed.items.find((source) => source.id === "web")?.deviceId).toBe(phone.id);
  });

  test("(6) unpairing in the app leaves Safari with no pairing and nothing queued", async () => {
    // A page read while the gateway cannot be reached waits in Safari's queue.
    appGateway = "https://127.0.0.1:9";
    await expect(
      read("https://trails.example.org/waiting", "Waiting", "Read while the gateway is away."),
    ).resolves.toEqual({ accepted: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(String(storage.data.get("omnesis.push.queue.v1"))).toContain(
      "trails.example.org/waiting",
    );
    appGateway = gatewayUrl;

    appPaired = false;
    expect(await ask<SafariPopupAck>({ type: "safari-status" }, popup)).toEqual({
      ok: true,
      status: { paired: false },
    });
    expect(storage.data.has("omnesis.pairing.v1")).toBe(false);
    expect(String(storage.data.get("omnesis.push.queue.v1") ?? "")).not.toContain(
      "trails.example.org/waiting",
    );
    const before = await webDocCount();
    await expect(
      read("https://trails.example.org/summit", "Summit", "Read after unpairing."),
    ).resolves.toEqual({ accepted: false });
    expect(await webDocCount()).toBe(before);
  });
});
