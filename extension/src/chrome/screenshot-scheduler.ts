// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { PageScreenshot, ScreenshotSkip } from "./screenshot.js";

/**
 * When a page's screenshot is taken, in Chrome and in Safari alike.
 *
 * The first try is made right after the page's capture is queued. A page that
 * is not in view at that moment — another tab or app in front, a window that
 * lost focus, a page still settling or one the person is typing into — is
 * remembered as pending for its tab, and tried again the next time that tab
 * comes into view: it becomes the active tab, its window regains focus, or the
 * page itself reports it is visible and focused again. Every try is judged
 * afresh: the tab must still show the exact address the capture was sent
 * from, and the page must still confirm it holds the same capture.
 *
 * A pending shot is bounded: a few tries, half an hour, and it goes the moment
 * its tab closes, navigates away or emits another capture. Only one shot is
 * taken at a time, and a shot is always queued behind its page.
 */

export const PENDING_SCREENSHOTS_KEY = "omnesis.screenshots.pending.v1";

/** Tries per capture, the first one included. */
export const MAX_SCREENSHOT_ATTEMPTS = 4;

/** A pending shot older than this is dropped unseen. */
export const PENDING_SCREENSHOT_TTL_MS = 30 * 60 * 1000;

/** At most this many tabs wait for a shot; the oldest give way. */
export const MAX_PENDING_SCREENSHOTS = 16;

/** How long a tab that just came into view is left to paint and take focus. */
export const SCREENSHOT_SETTLE_MS = 500;

/** The skips that say "not now" rather than "never". */
const TRANSIENT_SKIPS: ReadonlySet<ScreenshotSkip> = new Set([
  "not-in-view",
  "unconfirmed",
  "changed",
  "capture-failed",
]);

export function isTransientScreenshotSkip(skip: ScreenshotSkip): boolean {
  return TRANSIENT_SKIPS.has(skip);
}

/** The screenshot one queued capture asked for. */
export interface ScreenshotRequest {
  tabId: number;
  /** The exact frame address the capture was sent from. */
  frameUrl: string;
  normalizedUrl: string;
  externalId: string;
  contentHash: string;
  /** The pairing the capture was queued under. */
  pairingId: string;
}

interface PendingScreenshot extends ScreenshotRequest {
  /** Tries made so far. */
  attempts: number;
  /** Epoch-ms of the first try. */
  since: number;
}

/** The slice of a `storage` area the pending list is kept in. */
export interface PendingScreenshotStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface ScreenshotSchedulerDeps {
  storage: PendingScreenshotStorage;
  /**
   * Whether this capture still wants a shot at all: the browser may take one,
   * the pairing that queued the page is still in force, the shared policy has
   * screenshots on, and no shot of this text is uploaded or queued.
   */
  wanted(request: ScreenshotRequest): Promise<boolean>;
  shoot(request: ScreenshotRequest): Promise<PageScreenshot | ScreenshotSkip>;
  /** Queue the shot behind its page; false when it may no longer go. */
  deliver(request: ScreenshotRequest, shot: PageScreenshot): Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  settleMs?: number;
}

/** What one try came to. */
export type ScreenshotOutcome = "queued" | "pending" | "dropped" | "idle";

export interface ScreenshotScheduler {
  /** First try for a capture just queued; replaces whatever its tab waited for. */
  capture(request: ScreenshotRequest): Promise<ScreenshotOutcome>;
  /** The tab came into view; try its pending shot, if any. */
  inView(tabId: number): Promise<ScreenshotOutcome>;
  /** The tab now shows `url`; a pending shot of another address goes. */
  navigated(tabId: number, url: string): Promise<void>;
  /** The tab closed. */
  closed(tabId: number): Promise<void>;
}

function parsePending(raw: unknown): PendingScreenshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Partial<PendingScreenshot>;
  const strings = [
    entry.frameUrl,
    entry.normalizedUrl,
    entry.externalId,
    entry.contentHash,
    entry.pairingId,
  ];
  if (!strings.every((value) => typeof value === "string" && value.length > 0)) return null;
  if (
    !Number.isInteger(entry.tabId) ||
    !Number.isInteger(entry.attempts) ||
    typeof entry.since !== "number"
  ) {
    return null;
  }
  return entry as PendingScreenshot;
}

function sameCapture(a: ScreenshotRequest, b: ScreenshotRequest): boolean {
  return (
    a.tabId === b.tabId &&
    a.frameUrl === b.frameUrl &&
    a.externalId === b.externalId &&
    a.contentHash === b.contentHash &&
    a.pairingId === b.pairingId
  );
}

export function createScreenshotScheduler(deps: ScreenshotSchedulerDeps): ScreenshotScheduler {
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const settleMs = deps.settleMs ?? SCREENSHOT_SETTLE_MS;
  /** Tabs with a try already on its way, so a burst of events makes one try. */
  const waking = new Set<number>();

  let lane: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = lane.then(work, work);
    lane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function readPending(): Promise<Map<number, PendingScreenshot>> {
    const out = new Map<number, PendingScreenshot>();
    let raw: unknown;
    try {
      raw = (await deps.storage.get(PENDING_SCREENSHOTS_KEY))[PENDING_SCREENSHOTS_KEY];
    } catch {
      return out;
    }
    if (!Array.isArray(raw)) return out;
    const at = now();
    for (const item of raw) {
      const entry = parsePending(item);
      if (!entry) continue;
      if (at - entry.since > PENDING_SCREENSHOT_TTL_MS || entry.since - at > 60_000) continue;
      if (entry.attempts >= MAX_SCREENSHOT_ATTEMPTS) continue;
      out.set(entry.tabId, entry);
    }
    return out;
  }

  async function writePending(pending: Map<number, PendingScreenshot>): Promise<void> {
    const kept = [...pending.values()]
      .sort((a, b) => a.since - b.since)
      .slice(-MAX_PENDING_SCREENSHOTS);
    await deps.storage.set({ [PENDING_SCREENSHOTS_KEY]: kept });
  }

  async function update(
    change: (pending: Map<number, PendingScreenshot>) => boolean,
  ): Promise<void> {
    const pending = await readPending();
    if (change(pending)) await writePending(pending);
  }

  /** Forget `request` if it is still what its tab waits for. */
  function settle(request: ScreenshotRequest): Promise<void> {
    return update((pending) => {
      const current = pending.get(request.tabId);
      if (!current || !sameCapture(current, request)) return false;
      pending.delete(request.tabId);
      return true;
    });
  }

  async function attempt(entry: PendingScreenshot): Promise<ScreenshotOutcome> {
    if (!(await deps.wanted(entry))) {
      await settle(entry);
      return "dropped";
    }
    const shot = await deps.shoot(entry);
    if (typeof shot !== "string") {
      await settle(entry);
      return (await deps.deliver(entry, shot)) ? "queued" : "dropped";
    }
    const attempts = entry.attempts + 1;
    if (!isTransientScreenshotSkip(shot) || attempts >= MAX_SCREENSHOT_ATTEMPTS) {
      await settle(entry);
      return "dropped";
    }
    await update((pending) => {
      const current = pending.get(entry.tabId);
      // A newer capture of this tab took the slot while this one was shot.
      if (current && !sameCapture(current, entry)) return false;
      pending.set(entry.tabId, { ...entry, attempts });
      return true;
    });
    return "pending";
  }

  return {
    capture(request) {
      return serialize(async () => {
        const entry: PendingScreenshot = { ...request, attempts: 0, since: now() };
        await update((pending) => {
          pending.set(request.tabId, entry);
          return true;
        });
        return attempt(entry);
      });
    },

    async inView(tabId) {
      if (waking.has(tabId)) return "idle";
      if (!(await readPending()).has(tabId)) return "idle";
      waking.add(tabId);
      try {
        await sleep(settleMs);
        return await serialize(async () => {
          const entry = (await readPending()).get(tabId);
          return entry ? attempt(entry) : "idle";
        });
      } finally {
        waking.delete(tabId);
      }
    },

    navigated(tabId, url) {
      return serialize(() =>
        update((pending) => {
          const current = pending.get(tabId);
          if (!current || current.frameUrl === url) return false;
          pending.delete(tabId);
          return true;
        }),
      );
    },

    closed(tabId) {
      return serialize(() =>
        update((pending) => {
          if (!pending.has(tabId)) return false;
          pending.delete(tabId);
          return true;
        }),
      );
    },
  };
}
