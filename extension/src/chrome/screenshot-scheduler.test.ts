// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  createScreenshotScheduler,
  MAX_PENDING_SCREENSHOTS,
  MAX_SCREENSHOT_ATTEMPTS,
  PENDING_SCREENSHOT_TTL_MS,
  PENDING_SCREENSHOTS_KEY,
  type ScreenshotRequest,
  type ScreenshotSchedulerDeps,
} from "./screenshot-scheduler.js";
import type { PageScreenshot, ScreenshotSkip } from "./screenshot.js";

const PAGE = "https://garden.example.org/invented-planting-guide";

function request(overrides: Partial<ScreenshotRequest> = {}): ScreenshotRequest {
  return {
    tabId: 4,
    frameUrl: PAGE,
    normalizedUrl: PAGE,
    externalId: "e".repeat(64),
    contentHash: "c".repeat(64),
    pairingId: "p".repeat(64),
    ...overrides,
  };
}

const SHOT: PageScreenshot = {
  contentType: "image/jpeg",
  width: 640,
  height: 1280,
  capturedAt: "2026-02-01T09:00:00.000Z",
  image: "AAAA",
};

function harness(outcomes: Array<PageScreenshot | ScreenshotSkip>, wanted = true) {
  const data: Record<string, unknown> = {};
  let clock = 1_000_000;
  const shoot = vi.fn(async () => outcomes.shift() ?? "not-in-view");
  const deliver = vi.fn(async () => true);
  const wantedFn = vi.fn(async () => wanted);
  const deps: ScreenshotSchedulerDeps = {
    storage: {
      get: async (key) => (key in data ? { [key]: data[key] } : {}),
      set: async (items) => void Object.assign(data, items),
    },
    wanted: wantedFn,
    shoot,
    deliver,
    now: () => clock,
    sleep: async () => undefined,
  };
  return {
    scheduler: createScreenshotScheduler(deps),
    shoot,
    deliver,
    wanted: wantedFn,
    pending: () => (data[PENDING_SCREENSHOTS_KEY] as unknown[] | undefined) ?? [],
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("page screenshot scheduling", () => {
  it("queues a shot taken at once and remembers nothing", async () => {
    const h = harness([SHOT]);
    await expect(h.scheduler.capture(request())).resolves.toBe("queued");
    expect(h.deliver).toHaveBeenCalledWith(expect.objectContaining({ tabId: 4 }), SHOT);
    expect(h.pending()).toEqual([]);
  });

  it("keeps a shot missed out of view and takes it when the tab is back in view", async () => {
    const h = harness(["not-in-view", SHOT]);
    await expect(h.scheduler.capture(request())).resolves.toBe("pending");
    expect(h.pending()).toHaveLength(1);
    expect(h.deliver).not.toHaveBeenCalled();
    await expect(h.scheduler.inView(4)).resolves.toBe("queued");
    expect(h.shoot).toHaveBeenCalledTimes(2);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.pending()).toEqual([]);
  });

  it.each(["unconfirmed", "changed", "capture-failed"] as const)(
    "retries after %s",
    async (skip) => {
      const h = harness([skip, SHOT]);
      await expect(h.scheduler.capture(request())).resolves.toBe("pending");
      await expect(h.scheduler.inView(4)).resolves.toBe("queued");
    },
  );

  it("does not retry an image too large to keep", async () => {
    const h = harness(["too-large"]);
    await expect(h.scheduler.capture(request())).resolves.toBe("dropped");
    expect(h.pending()).toEqual([]);
    await expect(h.scheduler.inView(4)).resolves.toBe("idle");
    expect(h.shoot).toHaveBeenCalledTimes(1);
  });

  it("only tries the tab that came into view", async () => {
    const h = harness(["not-in-view"]);
    await h.scheduler.capture(request());
    await expect(h.scheduler.inView(9)).resolves.toBe("idle");
    expect(h.shoot).toHaveBeenCalledTimes(1);
  });

  it(`gives up after ${MAX_SCREENSHOT_ATTEMPTS} tries`, async () => {
    const h = harness([]);
    await h.scheduler.capture(request());
    for (let i = 1; i < MAX_SCREENSHOT_ATTEMPTS; i += 1) await h.scheduler.inView(4);
    expect(h.shoot).toHaveBeenCalledTimes(MAX_SCREENSHOT_ATTEMPTS);
    expect(h.pending()).toEqual([]);
    await expect(h.scheduler.inView(4)).resolves.toBe("idle");
    expect(h.shoot).toHaveBeenCalledTimes(MAX_SCREENSHOT_ATTEMPTS);
  });

  it("forgets a pending shot once it is half an hour old", async () => {
    const h = harness(["not-in-view", SHOT]);
    await h.scheduler.capture(request());
    h.advance(PENDING_SCREENSHOT_TTL_MS + 1);
    await expect(h.scheduler.inView(4)).resolves.toBe("idle");
    expect(h.shoot).toHaveBeenCalledTimes(1);
  });

  it("drops a pending shot when its tab navigates away, and keeps it on the same address", async () => {
    const h = harness(["not-in-view", SHOT]);
    await h.scheduler.capture(request());
    await h.scheduler.navigated(4, PAGE);
    expect(h.pending()).toHaveLength(1);
    await h.scheduler.navigated(4, `${PAGE}/comments`);
    expect(h.pending()).toEqual([]);
    await expect(h.scheduler.inView(4)).resolves.toBe("idle");
  });

  it("drops a pending shot when its tab closes", async () => {
    const h = harness(["not-in-view"]);
    await h.scheduler.capture(request());
    await h.scheduler.closed(4);
    expect(h.pending()).toEqual([]);
  });

  it("asks again whether the shot is still wanted before each retry", async () => {
    const h = harness(["not-in-view", SHOT]);
    await h.scheduler.capture(request());
    h.wanted.mockResolvedValue(false);
    await expect(h.scheduler.inView(4)).resolves.toBe("dropped");
    expect(h.shoot).toHaveBeenCalledTimes(1);
    expect(h.pending()).toEqual([]);
  });

  it("lets a new capture of the tab replace the one waiting", async () => {
    const h = harness(["not-in-view", "not-in-view", SHOT]);
    await h.scheduler.capture(request());
    await h.scheduler.capture(request({ contentHash: "d".repeat(64) }));
    expect(h.pending()).toEqual([expect.objectContaining({ contentHash: "d".repeat(64) })]);
    await h.scheduler.inView(4);
    expect(h.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ contentHash: "d".repeat(64) }),
      SHOT,
    );
  });

  it("makes one try for a burst of in-view events", async () => {
    const h = harness(["not-in-view", SHOT]);
    await h.scheduler.capture(request());
    const outcomes = await Promise.all([h.scheduler.inView(4), h.scheduler.inView(4)]);
    expect(outcomes.sort()).toEqual(["idle", "queued"]);
    expect(h.shoot).toHaveBeenCalledTimes(2);
  });

  it(`keeps at most ${MAX_PENDING_SCREENSHOTS} tabs waiting, the newest`, async () => {
    const h = harness([]);
    for (let tabId = 1; tabId <= MAX_PENDING_SCREENSHOTS + 3; tabId += 1) {
      h.advance(1);
      await h.scheduler.capture(request({ tabId }));
    }
    const tabs = (h.pending() as Array<{ tabId: number }>).map((entry) => entry.tabId);
    expect(tabs).toHaveLength(MAX_PENDING_SCREENSHOTS);
    expect(tabs).not.toContain(1);
    expect(tabs).toContain(MAX_PENDING_SCREENSHOTS + 3);
  });
});
