// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { judgeCaptureUrl, type WebCapturePolicy } from "@omnesis/provider-web/capture-policy";
import { hashText } from "../capture/content-hash.js";
import {
  clearCachedPolicy,
  policyIsStale,
  readCachedPolicy,
  writeCachedPolicy,
} from "../capture/policy.js";
import { MAX_CAPTURE_URL_CHARS } from "../capture/lifecycle.js";
import { CAPTURE_PERMISSION_STATE_KEY } from "../chrome/capture-permission-state.js";
import {
  capturePairingId,
  clearPendingHandoffs,
  pendingHandoffKeys,
  readPendingHandoffs,
} from "../chrome/handoff-storage.js";
import {
  CAPTURE_HANDOFF_FAILURE_KEY,
  isCaptureMessage,
  type CaptureAck,
  type CaptureEligibilityResponse,
  type ContentToSwMessage,
} from "../chrome/messages.js";
import { PAIRING_KEY, parsePairing, type BrowserPairing } from "../chrome/pairing-record.js";
import { CapturePolicyClient } from "../push/capture-policy.js";
import { clearPushObservability, clearPushQueue, PushClient } from "../push/client.js";
import { buildPageVisit, buildWebPageDocument } from "../push/documents.js";
import { REQUIRED_WEB_SCOPE } from "../push/pairing.js";
import {
  createNativeFetch,
  readNativeStatus,
  SAFARI_GATEWAY_ORIGIN,
  type SendNativeMessage,
} from "./native-bridge.js";
import { safariHandoffStorage, type SafariStorageArea } from "./storage.js";
import {
  isSafariPopupMessage,
  SAFARI_SYNC_MESSAGE_TYPE,
  type SafariPopupAck,
  type SafariPopupMessage,
  type SafariStatus,
} from "./messages.js";
import type { DurableStore } from "../push/types.js";

/** The gateway's real host, kept beside the pairing so its own pages are never captured. */
export const SAFARI_GATEWAY_HOST_KEY = "omnesis.safari.gatewayHost.v1";

/** How the gateway labels pages this extension captured. */
export const SAFARI_PROFILE_LABEL = "Safari";

export const SAFARI_DRAIN_ALARM = "omnesis.safari.drain";
export const SAFARI_RETRY_ALARM = "omnesis.safari.retry-drain";
const DRAIN_PERIOD_MINUTES = 1;

/** A page asking to sync re-reads the app's pairing at most this often while paired. */
const PAIRING_SYNC_INTERVAL_MS = 60_000;

/** The push client requires a token; the app attaches the real one. */
const NATIVE_CREDENTIAL_PLACEHOLDER = "native";

export interface SafariMessageSender {
  id?: string;
  url?: string;
  tab?: { id?: number; incognito?: boolean };
}

export interface SafariBackgroundDeps {
  storage: SafariStorageArea;
  sendNative: SendNativeMessage;
  alarms?: { create(name: string, info: { when?: number; periodInMinutes?: number }): void };
  runtimeId: string;
  now?: () => number;
  nativeTimeoutMs?: number;
}

export interface SafariBackground {
  /** Run once per background wake: adopt the app's pairing, replay staged captures, drain. */
  start(): Promise<void>;
  handleMessage(
    message: unknown,
    sender: SafariMessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean;
  handleAlarm(name: string): void;
}

function isObjectWithType(message: unknown, type: string): boolean {
  return (
    typeof message === "object" && message !== null && (message as { type?: unknown }).type === type
  );
}

export function createSafariBackground(deps: SafariBackgroundDeps): SafariBackground {
  const { storage, sendNative, runtimeId } = deps;
  const now = deps.now ?? (() => Date.now());
  const handoffs = safariHandoffStorage(storage);
  const store: DurableStore = {
    async get(key) {
      const value = (await storage.get(key))[key];
      return typeof value === "string" ? value : undefined;
    },
    async set(key, value) {
      await storage.set({ [key]: value });
    },
  };
  const sessionId = crypto.randomUUID();
  let clientGeneration = 0;
  let lastPairingSyncAt = 0;
  let pairingSync: Promise<BrowserPairing | null> | null = null;
  let policyRefresh: { pairing: string; promise: Promise<WebCapturePolicy | null> } | null = null;

  let queueWork: Promise<unknown> = Promise.resolve();
  function serializeQueueWork<T>(work: () => Promise<T>): Promise<T> {
    const result = queueWork.then(work, work);
    queueWork = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  const nativeFetch = createNativeFetch(sendNative, {
    ...(deps.nativeTimeoutMs !== undefined ? { timeoutMs: deps.nativeTimeoutMs } : {}),
    // The app lost its pairing between two requests; stop the pages now
    // instead of at the next periodic sync.
    onUnpaired: () => void syncPairing(true),
  });

  async function loadPairing(): Promise<BrowserPairing | null> {
    return parsePairing((await storage.get(PAIRING_KEY))[PAIRING_KEY]);
  }

  async function loadGatewayHost(): Promise<string> {
    const host = (await storage.get(SAFARI_GATEWAY_HOST_KEY))[SAFARI_GATEWAY_HOST_KEY];
    return typeof host === "string" ? host : "";
  }

  /** Everything staged or cached for one pairing leaves with it. */
  async function forgetPairingState(): Promise<void> {
    await clearPendingHandoffs(handoffs);
    await clearPushQueue(store);
    await clearPushObservability(store);
    await clearCachedPolicy(store);
  }

  /**
   * Mirror the app's pairing into storage, where the page scripts read it.
   * The app is the only place a pairing is made or removed; a status the app
   * could not give leaves the last known state in force.
   */
  function syncPairing(force = false): Promise<BrowserPairing | null> {
    if (pairingSync) return pairingSync;
    const work = serializeQueueWork(async () => {
      const current = await loadPairing();
      if (!force && current && now() - lastPairingSyncAt < PAIRING_SYNC_INTERVAL_MS) {
        return current;
      }
      const status = await readNativeStatus(sendNative, deps.nativeTimeoutMs);
      if (!status) return current;
      lastPairingSyncAt = now();
      if (!status.paired) {
        if (current) {
          await storage.remove([PAIRING_KEY, SAFARI_GATEWAY_HOST_KEY]);
          await storage.set({ [CAPTURE_PERMISSION_STATE_KEY]: false });
          await forgetPairingState();
        }
        return null;
      }
      const sameDevice = current?.deviceId === status.deviceId;
      if (!sameDevice) {
        if (current) await forgetPairingState();
        const pairing: BrowserPairing = {
          gatewayUrl: SAFARI_GATEWAY_ORIGIN,
          scopes: [REQUIRED_WEB_SCOPE],
          deviceId: status.deviceId,
          pairedAt: now(),
        };
        await storage.set({
          [SAFARI_GATEWAY_HOST_KEY]: status.gatewayHost,
          [CAPTURE_PERMISSION_STATE_KEY]: true,
          [PAIRING_KEY]: JSON.stringify(pairing),
        });
        return pairing;
      }
      if ((await loadGatewayHost()) !== status.gatewayHost) {
        await storage.set({ [SAFARI_GATEWAY_HOST_KEY]: status.gatewayHost });
      }
      return current;
    });
    pairingSync = work;
    void work.then(
      () => {
        if (pairingSync === work) pairingSync = null;
      },
      () => {
        if (pairingSync === work) pairingSync = null;
      },
    );
    return work;
  }

  async function buildClient(): Promise<PushClient | null> {
    if (!(await loadPairing())) return null;
    clientGeneration += 1;
    return new PushClient({
      gatewayUrl: SAFARI_GATEWAY_ORIGIN,
      token: NATIVE_CREDENTIAL_PLACEHOLDER,
      fetch: nativeFetch,
      store,
      batchSize: 1,
      observationSessionId: sessionId,
      observationGeneration: clientGeneration,
      now,
    });
  }

  function policyClient(): CapturePolicyClient {
    return new CapturePolicyClient(
      SAFARI_GATEWAY_ORIGIN,
      NATIVE_CREDENTIAL_PLACEHOLDER,
      nativeFetch,
    );
  }

  function refreshPolicy(
    pairing: BrowserPairing,
    fallback: WebCapturePolicy | null,
  ): Promise<WebCapturePolicy | null> {
    if (policyRefresh?.pairing === pairing.deviceId) return policyRefresh.promise;
    const promise = (async () => {
      try {
        const policy = await policyClient().read();
        const current = await loadPairing();
        if (current?.deviceId !== pairing.deviceId) return fallback;
        await writeCachedPolicy(store, policy, now());
        return policy;
      } catch {
        return fallback;
      } finally {
        if (policyRefresh?.pairing === pairing.deviceId) policyRefresh = null;
      }
    })();
    policyRefresh = { pairing: pairing.deviceId, promise };
    return promise;
  }

  /**
   * The capture settings in force. A copy answers at once even when stale and
   * is refreshed behind the caller; with no copy nothing may be captured.
   */
  async function currentPolicy(opts: { refresh?: boolean } = {}): Promise<WebCapturePolicy | null> {
    const pairing = await loadPairing();
    if (!pairing) return null;
    const cached = await readCachedPolicy(store);
    if (cached && !opts.refresh && !policyIsStale(cached, now())) return cached.policy;
    const refresh = refreshPolicy(pairing, cached?.policy ?? null);
    if (cached && !opts.refresh) {
      void refresh;
      return cached.policy;
    }
    return refresh;
  }

  async function judgeEligibility(url: string): Promise<CaptureEligibilityResponse> {
    const pairing = (await loadPairing()) ?? (await syncPairing());
    if (!pairing) return { eligible: false, reason: "unpaired", skipPasswordForms: true };
    const policy = await currentPolicy();
    if (!policy) return { eligible: false, reason: "no-policy", skipPasswordForms: true };
    const verdict = judgeCaptureUrl(policy, url, {
      gatewayHost: await loadGatewayHost(),
      now: now(),
    });
    const skipPasswordForms = policy.rules.skipPasswordForms;
    return verdict.allowed
      ? { eligible: true, skipPasswordForms }
      : { eligible: false, reason: verdict.reason, skipPasswordForms };
  }

  function handleCapture(
    message: Extract<ContentToSwMessage, { type: "capture" }>,
  ): Promise<CaptureAck> {
    return serializeQueueWork(async () => {
      const finish = async (ack: CaptureAck): Promise<CaptureAck> => {
        if (message.handoffKey) await storage.remove(message.handoffKey);
        return ack;
      };
      const refuse = (): Promise<CaptureAck> => finish({ ok: true, accepted: false });
      const pairing = await loadPairing();
      if (!pairing) return refuse();
      if (message.handoffKey && message.pairingId !== (await capturePairingId(pairing))) {
        return refuse();
      }
      const client = await buildClient();
      if (!client) return refuse();
      // A source the gateway holds as removed or paused takes no new captures
      // while one queued item keeps probing for its return.
      if ((await client.getServerState()) && (await client.queueDepth()) > 0) return refuse();
      const policy = await currentPolicy();
      if (!policy) return refuse();
      const { emission } = message;
      try {
        const emissionUrl = new URL(emission.normalizedUrl);
        if (emissionUrl.username || emissionUrl.password) return refuse();
      } catch {
        return refuse();
      }
      const externalId = await hashText(emission.normalizedUrl);
      const verdict = judgeCaptureUrl(policy, emission.normalizedUrl, {
        gatewayHost: await loadGatewayHost(),
        now: now(),
        externalId,
      });
      if (!verdict.allowed) return refuse();
      const browserProfile = { deviceId: pairing.deviceId, label: SAFARI_PROFILE_LABEL };
      if (emission.contentChanged) {
        await client.enqueueDocument(
          await buildWebPageDocument({
            normalizedUrl: emission.normalizedUrl,
            title: emission.title,
            text: emission.text,
            contentHash: emission.contentHash,
            visitedAt: emission.visitedAt,
            browserProfile,
          }),
        );
      }
      if (emission.kind === "visit") {
        await client.enqueueVisit(
          buildPageVisit({
            normalizedUrl: emission.normalizedUrl,
            title: emission.title,
            visitedAt: emission.visitedAt,
            dwellMs: emission.dwellMs,
            browserProfile,
          }),
        );
      }
      return finish({ ok: true, accepted: true });
    });
  }

  /** Captures a page staged before a background that was stopped could take them. */
  async function recoverPendingHandoffs(): Promise<void> {
    const pairing = await loadPairing();
    const pairingId = pairing ? await capturePairingId(pairing) : null;
    for (const item of await readPendingHandoffs(handoffs)) {
      try {
        if (!item.record || !pairingId || item.record.pairingId !== pairingId) {
          await storage.remove(item.key);
          continue;
        }
        await handleCapture({
          type: "capture",
          emission: item.record.emission,
          handoffKey: item.key,
          pairingId: item.record.pairingId,
        });
      } catch {
        // One unreadable record must not hold the rest of the outbox.
      }
    }
    if ((await pendingHandoffKeys(handoffs)).length === 0) {
      await storage.set({ [CAPTURE_HANDOFF_FAILURE_KEY]: "" });
    }
  }

  async function drainWork(): Promise<boolean> {
    const client = await buildClient();
    if (!client || (await client.queueDepth()) === 0) return false;
    const result = await client.drain();
    const readyAgain = result.nextEligibleAt !== null && result.nextEligibleAt <= now();
    if (result.nextEligibleAt !== null && !readyAgain) {
      const delayMs = Math.max(0, result.nextEligibleAt - now());
      if (delayMs < DRAIN_PERIOD_MINUTES * 60 * 1000) {
        deps.alarms?.create(SAFARI_RETRY_ALARM, { when: result.nextEligibleAt });
      }
    }
    if (result.suppressed > 0) await currentPolicy({ refresh: true });
    return readyAgain;
  }

  function drain(): Promise<void> {
    return serializeQueueWork(drainWork).then(
      (readyAgain) => {
        if (readyAgain) void drain();
      },
      () => undefined,
    );
  }

  async function readStatus(opts: { fresh: boolean }): Promise<SafariStatus> {
    const pairing = opts.fresh ? await syncPairing(true) : await loadPairing();
    if (!pairing) return { paired: false };
    const policy = await currentPolicy({ refresh: opts.fresh });
    const client = await buildClient();
    const [gatewayHost, queued, health, recent] = await Promise.all([
      loadGatewayHost(),
      client ? client.queueDepth() : 0,
      client ? client.getHealth() : null,
      client ? client.getRecentDeliveries() : [],
    ]);
    const pausedUntil = policy?.pause ? policy.pause.until : undefined;
    const paused =
      policy?.pause !== null &&
      policy?.pause !== undefined &&
      (policy.pause.until === null || policy.pause.until > now());
    return {
      paired: true,
      gatewayHost,
      policyKnown: policy !== null,
      paused,
      ...(paused && typeof pausedUntil === "number" ? { pausedUntil } : {}),
      excludedDomains: policy?.excludedDomains ?? [],
      queued,
      healthy: health?.ok !== false,
      ...(recent[0] ? { lastCapturedAt: recent[0].at } : {}),
    };
  }

  async function handlePopupMessage(message: SafariPopupMessage): Promise<SafariPopupAck> {
    if (message.type === "safari-status") {
      return { ok: true, status: await readStatus({ fresh: true }) };
    }
    if (!(await loadPairing())) return { ok: false, reason: "Pair the Omnesis app first" };
    // On the queue lane, so no capture racing a pause or an exclusion is
    // queued once the gateway has confirmed it.
    await serializeQueueWork(async () => {
      const client = policyClient();
      let policy: WebCapturePolicy;
      if (message.type === "safari-set-pause") policy = await client.setPause(message.until);
      else if (message.type === "safari-resume") policy = await client.clearPause();
      else if (message.type === "safari-exclude") {
        policy = (await client.addExcludedDomain(message.domain, false)).policy;
      } else policy = await client.removeExcludedDomain(message.domain);
      await writeCachedPolicy(store, policy, now());
    });
    return { ok: true, status: await readStatus({ fresh: false }) };
  }

  function respond<T>(
    work: Promise<T>,
    sendResponse: (response?: unknown) => void,
    onError: (error: unknown) => unknown,
  ): void {
    work.then(
      (value) => sendResponse(value),
      (error: unknown) => sendResponse(onError(error)),
    );
  }

  return {
    async start() {
      deps.alarms?.create(SAFARI_DRAIN_ALARM, { periodInMinutes: DRAIN_PERIOD_MINUTES });
      // Read the capture settings now, so the first page of this wake is not
      // refused for want of them.
      if (await syncPairing(true)) await currentPolicy();
      await recoverPendingHandoffs();
      await drain();
    },

    handleMessage(message, sender, sendResponse) {
      if (sender.id !== runtimeId) return false;
      const fromPage = sender.tab?.id !== undefined && sender.tab.incognito !== true;
      if (fromPage && isCaptureMessage(message)) {
        respond(
          handleCapture(message).then((ack) => {
            if (ack.ok && ack.accepted) void drain();
            return ack;
          }),
          sendResponse,
          () => ({ ok: false, reason: "queue-unavailable" }) satisfies CaptureAck,
        );
        return true;
      }
      if (
        fromPage &&
        isObjectWithType(message, "capture-eligibility") &&
        typeof (message as { url?: unknown }).url === "string" &&
        (message as { url: string }).url.length <= MAX_CAPTURE_URL_CHARS
      ) {
        respond(
          judgeEligibility((message as { url: string }).url),
          sendResponse,
          () => ({ eligible: true, skipPasswordForms: true }) satisfies CaptureEligibilityResponse,
        );
        return true;
      }
      if (fromPage && isObjectWithType(message, SAFARI_SYNC_MESSAGE_TYPE)) {
        respond(
          syncPairing().then((pairing) => ({ paired: pairing !== null })),
          sendResponse,
          () => ({ paired: false }),
        );
        return true;
      }
      if (sender.tab === undefined && isSafariPopupMessage(message)) {
        respond(
          handlePopupMessage(message),
          sendResponse,
          (error) =>
            ({
              ok: false,
              reason: error instanceof Error ? error.message : "The gateway did not answer",
            }) satisfies SafariPopupAck,
        );
        return true;
      }
      return false;
    },

    handleAlarm(name) {
      if (name === SAFARI_DRAIN_ALARM || name === SAFARI_RETRY_ALARM) void drain();
    },
  };
}
