// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, describe, expect, it } from "vitest";
import { hashText } from "../capture/content-hash.js";
import { CAPTURE_POLICY_KEY } from "../capture/policy.js";
import { CAPTURE_PERMISSION_STATE_KEY } from "../chrome/capture-permission-state.js";
import { capturePairingId } from "../chrome/handoff-storage.js";
import {
  CAPTURE_PENDING_PREFIX,
  type CaptureAck,
  type CaptureEligibilityResponse,
} from "../chrome/messages.js";
import { captureStorageAction } from "../chrome/capture-storage-change.js";
import { PAIRING_KEY, hasExactWebScope, parsePairing } from "../chrome/pairing-record.js";
import { QUEUE_STORAGE_KEY } from "../push/queue.js";
import {
  createSafariBackground,
  SAFARI_DRAIN_ALARM,
  SAFARI_GATEWAY_HOST_KEY,
  SAFARI_PROFILE_LABEL,
  type SafariBackground,
  type SafariMessageSender,
} from "./background.js";
import { SAFARI_GATEWAY_ORIGIN } from "./native-bridge.js";
import { safariHandoffStorage } from "./storage.js";
import { capturePolicy, FakeNativeApp, MemoryStorageArea } from "./test-fakes.js";
import type { SafariPopupAck } from "./messages.js";
import type { CaptureEmission } from "../capture/lifecycle.js";

const RUNTIME_ID = "safari-extension-id";
const page: SafariMessageSender = { id: RUNTIME_ID, tab: { id: 7, incognito: false } };
const POPUP_URL = "safari-web-extension://x/popup.html";
const popup: SafariMessageSender = { id: RUNTIME_ID, url: POPUP_URL };
const OTHER_DEVICE = {
  deviceId: "9b2f3c10-55aa-4e0e-8a11-2d7e6c4b1f02",
  gatewayHost: "home.example.net",
};

let storage: MemoryStorageArea;
let app: FakeNativeApp;
let clock: number;
let alarms: Map<string, { when?: number; periodInMinutes?: number }>;
let background: SafariBackground;

function boot(): SafariBackground {
  return createSafariBackground({
    storage,
    sendNative: app.send,
    alarms: {
      create: (name, info) => void alarms.set(name, info),
      clear: (name) => alarms.delete(name),
    },
    runtimeId: RUNTIME_ID,
    popupUrl: POPUP_URL,
    now: () => clock,
    nativeTimeoutMs: 200,
  });
}

function ask<T>(message: unknown, sender: SafariMessageSender = page): Promise<T | "unhandled"> {
  return new Promise((resolve) => {
    const handled = background.handleMessage(message, sender, (response) => resolve(response as T));
    if (!handled) resolve("unhandled");
  });
}

async function settled(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function emission(
  url: string,
  text: string,
  overrides: Partial<CaptureEmission> = {},
): Promise<CaptureEmission> {
  return {
    kind: "visit",
    normalizedUrl: url,
    title: "Trail conditions",
    text,
    contentHash: await hashText(text),
    visitedAt: new Date(clock).toISOString(),
    dwellMs: 8200,
    contentChanged: true,
    ...overrides,
  };
}

async function captureMessage(item: CaptureEmission, deviceId = app.pairing?.deviceId ?? "") {
  return {
    type: "capture",
    emission: item,
    handoffKey: `${CAPTURE_PENDING_PREFIX}page.visit.${await hashText(item.normalizedUrl)}`,
    pairingId: await capturePairingId({ gatewayUrl: SAFARI_GATEWAY_ORIGIN, deviceId }),
  };
}

beforeEach(() => {
  storage = new MemoryStorageArea();
  app = new FakeNativeApp();
  clock = Date.parse("2026-03-01T10:00:00Z");
  alarms = new Map();
  background = boot();
});

describe("pairing", () => {
  it("adopts the app's pairing as a web-only record the page scripts accept", async () => {
    await background.start();

    const pairing = parsePairing(storage.data.get(PAIRING_KEY));
    expect(pairing).toMatchObject({
      gatewayUrl: SAFARI_GATEWAY_ORIGIN,
      deviceId: app.pairing?.deviceId,
    });
    expect(pairing && hasExactWebScope(pairing)).toBe(true);
    expect(storage.data.get(CAPTURE_PERMISSION_STATE_KEY)).toBe(true);
    expect(storage.data.get(SAFARI_GATEWAY_HOST_KEY)).toBe("gateway.example.com");
  });

  it("stays unpaired, and answers pages so, until the app has a pairing", async () => {
    app.pairing = null;
    await background.start();
    expect(storage.data.has(PAIRING_KEY)).toBe(false);
    expect(
      await ask<CaptureEligibilityResponse>({
        type: "capture-eligibility",
        url: "https://news.example.org/story",
      }),
    ).toMatchObject({ eligible: false, reason: "unpaired" });

    app.pairing = OTHER_DEVICE;
    clock += 6_000;
    expect(await ask({ type: "safari-sync" })).toEqual({ paired: true });
    expect(storage.data.has(PAIRING_KEY)).toBe(true);
  });

  it("asks the app at most once a minute while paired, across background restarts", async () => {
    await background.start();
    const reads = app.statusReads;
    await ask({ type: "safari-sync" });
    background = boot();
    await background.start();
    expect(app.statusReads).toBe(reads);
    clock += 61_000;
    await ask({ type: "safari-sync" });
    expect(app.statusReads).toBe(reads + 1);
  });

  it("asks the app at most every few seconds while unpaired", async () => {
    app.pairing = null;
    await background.start();
    const reads = app.statusReads;
    await ask({ type: "safari-sync" });
    expect(app.statusReads).toBe(reads);
    clock += 6_000;
    await ask({ type: "safari-sync" });
    expect(app.statusReads).toBe(reads + 1);
  });

  it("asks the app at once when told to, even while an unhurried check is under way", async () => {
    await background.start();
    const reads = app.statusReads;
    const unhurried = ask({ type: "safari-sync" });
    const fresh = ask<SafariPopupAck>({ type: "safari-status" }, popup);
    await Promise.all([unhurried, fresh]);
    expect(app.statusReads).toBe(reads + 1);
  });

  it("drops the queue, the settings copy and the record when the app is unpaired", async () => {
    await background.start();
    app.online = false;
    const item = await emission("https://news.example.org/story", "Snow above the tree line.");
    await ask<CaptureAck>(await captureMessage(item));
    await settled();
    expect(String(storage.data.get(QUEUE_STORAGE_KEY))).toContain("news.example.org");

    app.pairing = null;
    clock += 61_000;
    expect(await ask({ type: "safari-sync" })).toEqual({ paired: false });

    expect(storage.data.has(PAIRING_KEY)).toBe(false);
    expect(String(storage.data.get(QUEUE_STORAGE_KEY) ?? "")).not.toContain("news.example.org");
    expect(storage.data.get(CAPTURE_POLICY_KEY) ?? "").toBe("");
  });

  it("stops open pages on unpairing in a way a later pairing can undo", async () => {
    await background.start();
    const before = new Map(storage.data);
    app.pairing = null;
    clock += 61_000;
    await ask({ type: "safari-sync" });

    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const key of new Set([...before.keys(), ...storage.data.keys()])) {
      if (before.get(key) !== storage.data.get(key)) {
        changes[key] = { oldValue: before.get(key), newValue: storage.data.get(key) };
      }
    }
    // The page script ends for good on "terminate"; "deactivate" waits for a pairing.
    expect(captureStorageAction(changes, "local")).toBe("deactivate");
    expect(storage.data.get(CAPTURE_PERMISSION_STATE_KEY)).toBe(true);
  });

  it("never sends one gateway's queued pages to the next", async () => {
    await background.start();
    app.online = false;
    const item = await emission("https://news.example.org/story", "Snow above the tree line.");
    await ask<CaptureAck>(await captureMessage(item));
    await settled();

    // The app is paired to another gateway while this background is still
    // awake and has not checked since: the next drain must not reach it.
    app.pairing = OTHER_DEVICE;
    app.online = true;
    clock += 10 * 60_000;
    background.handleAlarm(SAFARI_DRAIN_ALARM);
    await settled();

    expect(app.requests, "nothing was sent to the new gateway for the old one").toEqual([
      { method: "GET", path: "/web-capture-policy", body: undefined },
    ]);
    expect(app.delivered("/documents")).toEqual([]);
    expect(parsePairing(storage.data.get(PAIRING_KEY))?.deviceId).toBe(OTHER_DEVICE.deviceId);
    expect(storage.data.get(SAFARI_GATEWAY_HOST_KEY)).toBe("home.example.net");
    expect(String(storage.data.get(QUEUE_STORAGE_KEY) ?? "")).not.toContain("news.example.org");
  });

  it("starts the next pairing with no trace of the last one's refusals", async () => {
    await background.start();
    const item = await emission("https://news.example.org/story", "Snow above the tree line.");
    app.pairing = null;
    await ask<CaptureAck>(await captureMessage(item, "3f0c1a52-6d0b-4a55-9d3e-0c1f5b7a9e10"));
    await settled();

    app.pairing = OTHER_DEVICE;
    clock += 61_000;
    expect(await ask<SafariPopupAck>({ type: "safari-status" }, popup)).toMatchObject({
      ok: true,
      status: { paired: true, refused: false, reachable: true, queued: 0 },
    });
  });

  it("keeps the last known pairing when the app does not answer", async () => {
    await background.start();
    const silent = createSafariBackground({
      storage,
      sendNative: () => new Promise(() => undefined),
      runtimeId: RUNTIME_ID,
      popupUrl: POPUP_URL,
      now: () => clock + 120_000,
      nativeTimeoutMs: 20,
    });
    await silent.start();
    expect(storage.data.has(PAIRING_KEY)).toBe(true);
  });
});

describe("eligibility", () => {
  beforeEach(async () => {
    await background.start();
  });

  it("lets an ordinary page arm and reports the sensitive-field rule", async () => {
    expect(
      await ask<CaptureEligibilityResponse>({
        type: "capture-eligibility",
        url: "https://news.example.org/story",
      }),
    ).toEqual({ eligible: true, skipPasswordForms: true });
  });

  it("refuses the gateway's own pages by its real host", async () => {
    expect(
      await ask<CaptureEligibilityResponse>({
        type: "capture-eligibility",
        url: "https://gateway.example.com/portal/",
      }),
    ).toMatchObject({ eligible: false, reason: "gateway-host" });
  });

  it("refuses everything while no settings copy could be read", async () => {
    storage.data.delete(CAPTURE_POLICY_KEY);
    app.online = false;
    expect(
      await ask<CaptureEligibilityResponse>({
        type: "capture-eligibility",
        url: "https://news.example.org/story",
      }),
    ).toMatchObject({ eligible: false, reason: "no-policy" });
  });
});

describe("capture", () => {
  beforeEach(async () => {
    await background.start();
  });

  it("sends a page and its visit through the app, labelled as Safari on this device", async () => {
    const item = await emission("https://news.example.org/story", "Snow above the tree line.");
    const message = await captureMessage(item);
    storage.data.set(message.handoffKey, "staged");

    expect(await ask<CaptureAck>(message)).toEqual({ ok: true, accepted: true });
    await settled();

    expect(storage.data.has(message.handoffKey)).toBe(false);
    const [document] = app.delivered("/documents");
    expect(document?.body).toMatchObject({
      documents: [
        {
          providerId: "web",
          sourceId: "web",
          externalId: await hashText("https://news.example.org/story"),
          content: "Snow above the tree line.",
          metadata: {
            documentType: "webpage",
            sourceUrl: "https://news.example.org/story",
            extra: {
              browserDeviceId: app.pairing?.deviceId,
              browserProfileLabel: SAFARI_PROFILE_LABEL,
            },
          },
        },
      ],
    });
    const [visit] = app.delivered("/analytics/ingest");
    expect(visit?.body).toMatchObject({
      tableName: "page_visits",
      sourceId: "web",
      records: [{ url: "https://news.example.org/story", dwell_ms: 8200 }],
    });
  });

  it("sends a re-read of a changed page as a document only", async () => {
    const item = await emission("https://news.example.org/story", "Updated forecast.", {
      kind: "re-extract",
    });
    await ask<CaptureAck>(await captureMessage(item));
    await settled();
    expect(app.delivered("/documents")).toHaveLength(1);
    expect(app.delivered("/analytics/ingest")).toHaveLength(0);
  });

  it("queues nothing for an excluded site, a paused gateway or another pairing", async () => {
    app.policy = capturePolicy({ excludedDomains: ["example.org"] });
    storage.data.delete(CAPTURE_POLICY_KEY);
    const item = await emission("https://news.example.org/story", "Snow above the tree line.");
    expect(await ask<CaptureAck>(await captureMessage(item))).toEqual({
      ok: true,
      accepted: false,
    });

    app.policy = capturePolicy({ pause: { until: null } });
    storage.data.delete(CAPTURE_POLICY_KEY);
    const other = await emission("https://trails.example.net/map", "Ridge route.");
    expect(await ask<CaptureAck>(await captureMessage(other))).toEqual({
      ok: true,
      accepted: false,
    });

    app.policy = capturePolicy();
    storage.data.delete(CAPTURE_POLICY_KEY);
    expect(await ask<CaptureAck>(await captureMessage(other, "another-device"))).toEqual({
      ok: true,
      accepted: false,
    });

    await settled();
    expect(app.delivered("/documents")).toEqual([]);
  });

  it("keeps a page while the gateway is unreachable and sends it on a later wake", async () => {
    app.online = false;
    const item = await emission("https://news.example.org/story", "Snow above the tree line.");
    expect(await ask<CaptureAck>(await captureMessage(item))).toEqual({ ok: true, accepted: true });
    await settled();
    expect(app.delivered("/documents")).toEqual([]);
    expect(alarms.get(SAFARI_DRAIN_ALARM), "a periodic wake while pages wait").toEqual({
      periodInMinutes: 1,
    });

    app.online = true;
    clock += 10 * 60_000;
    const woken = boot();
    await woken.start();
    await settled();
    expect(app.delivered("/documents")).toHaveLength(1);
    expect(alarms.has(SAFARI_DRAIN_ALARM), "and none once nothing waits").toBe(false);
  });

  it("takes a capture a page staged before a stopped background could accept it", async () => {
    const item = await emission("https://news.example.org/story", "Snow above the tree line.");
    const message = await captureMessage(item);
    storage.data.set(
      message.handoffKey,
      JSON.stringify({
        at: clock,
        order: `${String(clock).padStart(16, "0")}.page.00000001`,
        pairingId: message.pairingId,
        emission: item,
      }),
    );

    const woken = boot();
    await woken.start();
    await settled();

    expect(app.delivered("/documents")).toHaveLength(1);
    expect(await safariHandoffStorage(storage).getKeys()).not.toContain(message.handoffKey);
  });

  it("ignores another extension, a private tab and a malformed capture", async () => {
    const item = await emission("https://news.example.org/story", "Snow above the tree line.");
    const message = await captureMessage(item);
    expect(await ask(message, { id: "someone-else", tab: { id: 1 } })).toBe("unhandled");
    expect(await ask(message, { id: RUNTIME_ID, tab: { id: 1, incognito: true } })).toBe(
      "unhandled",
    );
    expect(await ask({ ...message, pairingId: "short" })).toBe("unhandled");
  });

  it("takes capture settings changes from the popup page only", async () => {
    const pause = { type: "safari-set-pause", until: null };
    expect(await ask(pause, page)).toBe("unhandled");
    expect(await ask(pause, { id: RUNTIME_ID })).toBe("unhandled");
    expect(await ask(pause, { id: RUNTIME_ID, url: "safari-web-extension://x/other.html" })).toBe(
      "unhandled",
    );
    expect(await ask(pause, { id: "someone-else", url: POPUP_URL })).toBe("unhandled");
    expect(app.policy.pause).toBeNull();
  });
});

describe("popup", () => {
  beforeEach(async () => {
    await background.start();
  });

  it("reports the pairing, the settings and the queue", async () => {
    expect(await ask<SafariPopupAck>({ type: "safari-status" }, popup)).toEqual({
      ok: true,
      status: {
        paired: true,
        gatewayHost: "gateway.example.com",
        policyKnown: true,
        paused: false,
        excludedDomains: [],
        queued: 0,
        refused: false,
        reachable: true,
      },
    });
  });

  it("pauses, resumes and excludes on the gateway and answers with the result", async () => {
    const until = clock + 60 * 60 * 1000;
    expect(await ask<SafariPopupAck>({ type: "safari-set-pause", until }, popup)).toMatchObject({
      ok: true,
      status: { paused: true, pausedUntil: until },
    });
    expect(app.policy.pause).toEqual({ until });

    expect(await ask<SafariPopupAck>({ type: "safari-resume" }, popup)).toMatchObject({
      ok: true,
      status: { paused: false },
    });

    expect(
      await ask<SafariPopupAck>({ type: "safari-exclude", domain: "example.org" }, popup),
    ).toMatchObject({ ok: true, status: { excludedDomains: ["example.org"] } });
    expect(
      await ask<CaptureEligibilityResponse>({
        type: "capture-eligibility",
        url: "https://news.example.org/story",
      }),
    ).toMatchObject({ eligible: false, reason: "excluded-domain" });

    expect(
      await ask<SafariPopupAck>({ type: "safari-include", domain: "example.org" }, popup),
    ).toMatchObject({ ok: true, status: { excludedDomains: [] } });
  });

  it("treats a pause whose time has passed as not paused", async () => {
    app.policy = capturePolicy({ pause: { until: clock - 1000 } });
    expect(await ask<SafariPopupAck>({ type: "safari-status" }, popup)).toMatchObject({
      ok: true,
      status: { paused: false },
    });
  });

  it("says why when the gateway cannot take a change", async () => {
    app.online = false;
    const ack = await ask<SafariPopupAck>({ type: "safari-set-pause", until: null }, popup);
    expect(ack).toMatchObject({ ok: false });
  });

  it("reports unpaired once the app has no pairing", async () => {
    app.pairing = null;
    expect(await ask<SafariPopupAck>({ type: "safari-status" }, popup)).toEqual({
      ok: true,
      status: { paired: false },
    });
  });
});
