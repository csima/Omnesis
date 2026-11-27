// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  SyncNowBadRequestError,
  SyncNowCoordinator,
  SyncNowUnknownSourceError,
  clampSyncNowTimeout,
  type SyncNowPorts,
  type SyncNowSource,
  type SyncNowStatus,
} from "./sync-now.js";

const SCALE = 100;
const clock = {
  now: () => Date.now() * SCALE,
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(1, ms / SCALE))),
};

interface Harness {
  ports: SyncNowPorts;
  dispatches: string[];
  status: Map<string, SyncNowStatus>;
  docs: Map<string, number>;
  finish(id: string, newDocs?: number): void;
  begin(id: string): void;
}

function harness(
  sources: SyncNowSource[],
  opts: { autoCompleteMs?: number; dispatchError?: string } = {},
): Harness {
  const status = new Map<string, SyncNowStatus>();
  const docs = new Map<string, number>();
  const dispatches: string[] = [];
  for (const s of sources) {
    status.set(s.id, {
      state: "synced",
      lastSyncAt: new Date(Date.now() * SCALE - 600_000).toISOString(),
    });
    docs.set(s.id, 10);
  }
  const h: Harness = {
    status,
    docs,
    dispatches,
    begin: (id) => status.set(id, { ...status.get(id)!, state: "syncing" }),
    finish: (id, newDocs = 0) => {
      docs.set(id, (docs.get(id) ?? 0) + newDocs);
      status.set(id, { state: "synced", lastSyncAt: new Date(Date.now() * SCALE).toISOString() });
    },
    ports: {
      ...clock,
      listSources: () => sources,
      status: (id) => status.get(id) ?? null,
      documentCount: (id) => docs.get(id) ?? 0,
      dispatch: async (id) => {
        dispatches.push(id);
        if (opts.dispatchError) return { ok: false, error: opts.dispatchError };
        h.begin(id);
        if (opts.autoCompleteMs !== undefined) {
          setTimeout(() => h.finish(id, 2), opts.autoCompleteMs / SCALE);
        }
        return { ok: true, triggered: 1, skipped: 0 };
      },
    },
  };
  return h;
}

const GMAIL: SyncNowSource = { id: "gmail:a@example.com", type: "gmail", enabled: true };
const GMAIL2: SyncNowSource = { id: "gmail:b@example.com", type: "gmail", enabled: true };
const QUO: SyncNowSource = { id: "quo:ws1", type: "quo", enabled: true };
const SLACK: SyncNowSource = { id: "slack:t1", type: "slack", enabled: false };

describe("SyncNowCoordinator", () => {
  it("syncs a named source and reports structured metadata", async () => {
    const h = harness([GMAIL, QUO], { autoCompleteMs: 1_000 });
    const co = new SyncNowCoordinator(h.ports);
    const res = await co.syncNow({ sourceIds: [GMAIL.id] });
    expect(res.ok).toBe(true);
    expect(res.sourceIds).toEqual([GMAIL.id]);
    expect(res.newItems).toBe(2);
    expect(res.coalesced).toBe(false);
    expect(res.timedOut).toBe(false);
    expect(res.syncedAt).not.toBeNull();
    expect(res.lagMs).toBeGreaterThanOrEqual(0);
    expect(res.lagMs).toBeLessThan(60_000);
    expect(res.sources[0]).toMatchObject({ sourceId: GMAIL.id, outcome: "synced", newItems: 2 });
    expect(h.dispatches).toEqual([GMAIL.id]);
  });

  it("expands a source type to every account of that type only", async () => {
    const h = harness([GMAIL, GMAIL2, QUO], { autoCompleteMs: 500 });
    const co = new SyncNowCoordinator(h.ports);
    const res = await co.syncNow({ sourceType: "gmail" });
    expect(res.sourceIds).toEqual([GMAIL.id, GMAIL2.id]);
    expect(h.dispatches.sort()).toEqual([GMAIL.id, GMAIL2.id]);
    expect(res.newItems).toBe(4);
  });

  it("merges ids and type without duplicates", async () => {
    const h = harness([GMAIL, GMAIL2, QUO], { autoCompleteMs: 500 });
    const co = new SyncNowCoordinator(h.ports);
    const res = await co.syncNow({ sourceIds: [GMAIL.id, QUO.id], sourceType: "gmail" });
    expect(res.sourceIds).toEqual([GMAIL.id, GMAIL2.id, QUO.id]);
    expect(h.dispatches).toHaveLength(3);
  });

  it("coalesces concurrent callers into one dispatch", async () => {
    const h = harness([GMAIL], { autoCompleteMs: 3_000 });
    const co = new SyncNowCoordinator(h.ports, { cooldownMs: 0 });
    const [a, b, c] = await Promise.all([
      co.syncNow({ sourceIds: [GMAIL.id] }),
      co.syncNow({ sourceIds: [GMAIL.id] }),
      co.syncNow({ sourceType: "gmail" }),
    ]);
    expect(h.dispatches).toHaveLength(1);
    expect(a.coalesced).toBe(false);
    expect(b.coalesced).toBe(true);
    expect(c.coalesced).toBe(true);
    expect(b.sources[0]!.cooledDown).toBe(false);
    expect(b.newItems).toBe(2);
  });

  it("answers from the last run within the cooldown, then syncs again after it", async () => {
    const h = harness([GMAIL], { autoCompleteMs: 200 });
    const co = new SyncNowCoordinator(h.ports, { cooldownMs: 5_000 });
    await co.syncNow({ sourceIds: [GMAIL.id] });
    const again = await co.syncNow({ sourceIds: [GMAIL.id] });
    expect(h.dispatches).toHaveLength(1);
    expect(again.coalesced).toBe(true);
    expect(again.sources[0]!.cooledDown).toBe(true);
    expect(again.ok).toBe(true);

    await clock.sleep(6_000);
    await co.syncNow({ sourceIds: [GMAIL.id] });
    expect(h.dispatches).toHaveLength(2);
  });

  it("does not cool down when cooldownMs is 0", async () => {
    const h = harness([GMAIL], { autoCompleteMs: 200 });
    const co = new SyncNowCoordinator(h.ports, { cooldownMs: 0 });
    await co.syncNow({ sourceIds: [GMAIL.id] });
    await co.syncNow({ sourceIds: [GMAIL.id] });
    expect(h.dispatches).toHaveLength(2);
  });

  it("bounds the caller's wait with timeoutMs while the sync keeps running", async () => {
    const h = harness([GMAIL], { autoCompleteMs: 8_000 });
    const co = new SyncNowCoordinator(h.ports, { cooldownMs: 0 });
    const res = await co.syncNow({ sourceIds: [GMAIL.id], timeoutMs: 1_000 });
    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.sources[0]!.outcome).toBe("timeout");
    expect(res.elapsedMs).toBeLessThan(5_000);

    const joined = await co.syncNow({ sourceIds: [GMAIL.id], timeoutMs: 30_000 });
    expect(joined.coalesced).toBe(true);
    expect(joined.ok).toBe(true);
    expect(h.dispatches).toHaveLength(1);
  });

  it("clamps timeoutMs into the supported range", () => {
    expect(clampSyncNowTimeout(undefined)).toBe(20_000);
    expect(clampSyncNowTimeout(5)).toBe(1_000);
    expect(clampSyncNowTimeout(10_000_000)).toBe(60_000);
    expect(clampSyncNowTimeout(Number.NaN)).toBe(20_000);
    expect(clampSyncNowTimeout(7_500.9)).toBe(7_500);
  });

  it("gives up a never-completing sync at the flight cap", async () => {
    const h = harness([GMAIL]);
    const co = new SyncNowCoordinator(h.ports, { flightCapMs: 3_000 });
    const res = await co.syncNow({ sourceIds: [GMAIL.id], timeoutMs: 60_000 });
    expect(res.sources[0]!.outcome).toBe("error");
    expect(res.sources[0]!.message).toMatch(/no completion/);
  });

  it("reports unknown ids alongside known ones", async () => {
    const h = harness([GMAIL], { autoCompleteMs: 200 });
    const co = new SyncNowCoordinator(h.ports);
    const res = await co.syncNow({ sourceIds: [GMAIL.id, "nope:1"] });
    expect(res.unknown).toEqual(["nope:1"]);
    expect(res.sourceIds).toEqual([GMAIL.id]);
    expect(res.ok).toBe(true);
  });

  it("rejects when nothing resolves", async () => {
    const co = new SyncNowCoordinator(harness([GMAIL]).ports);
    await expect(co.syncNow({ sourceIds: ["nope:1"] })).rejects.toBeInstanceOf(
      SyncNowUnknownSourceError,
    );
    await expect(co.syncNow({ sourceType: "imessage" })).rejects.toBeInstanceOf(
      SyncNowUnknownSourceError,
    );
  });

  it("rejects an empty request", async () => {
    const co = new SyncNowCoordinator(harness([GMAIL]).ports);
    await expect(co.syncNow({})).rejects.toBeInstanceOf(SyncNowBadRequestError);
    await expect(co.syncNow({ sourceIds: [] })).rejects.toBeInstanceOf(SyncNowBadRequestError);
  });

  it("does not dispatch to a paused source", async () => {
    const h = harness([SLACK]);
    const co = new SyncNowCoordinator(h.ports);
    const res = await co.syncNow({ sourceIds: [SLACK.id] });
    expect(res.sources[0]!.outcome).toBe("paused");
    expect(res.ok).toBe(false);
    expect(h.dispatches).toEqual([]);
  });

  it("reports a dispatch failure and lets the next caller retry at once", async () => {
    const failing = harness([GMAIL], { dispatchError: "device offline" });
    const co = new SyncNowCoordinator(failing.ports);
    const res = await co.syncNow({ sourceIds: [GMAIL.id] });
    expect(res.sources[0]).toMatchObject({ outcome: "dispatch-failed", message: "device offline" });
    await co.syncNow({ sourceIds: [GMAIL.id] });
    expect(failing.dispatches).toHaveLength(2);
  });

  it("surfaces a source error raised by the sync", async () => {
    const h = harness([GMAIL]);
    const co = new SyncNowCoordinator(h.ports);
    h.ports.dispatch = async (id) => {
      h.dispatches.push(id);
      h.begin(id);
      setTimeout(
        () =>
          h.status.set(id, {
            state: "needs-auth",
            lastSyncAt: h.status.get(id)!.lastSyncAt,
            erroredAt: new Date().toISOString(),
            errorMessage: "token revoked",
          }),
        5,
      );
      return { ok: true, triggered: 1 };
    };
    const res = await co.syncNow({ sourceIds: [GMAIL.id] });
    expect(res.sources[0]).toMatchObject({ outcome: "needs-auth", message: "token revoked" });
    expect(res.ok).toBe(false);
  });

  it("counts a net document decrease as zero new items", async () => {
    const h = harness([GMAIL]);
    h.ports.dispatch = async (id) => {
      h.begin(id);
      setTimeout(() => h.finish(id, -4), 5);
      return { ok: true, triggered: 1 };
    };
    const co = new SyncNowCoordinator(h.ports);
    const res = await co.syncNow({ sourceIds: [GMAIL.id] });
    expect(res.newItems).toBe(0);
  });

  it("treats a source with no registered status as pending until it reports", async () => {
    const h = harness([GMAIL]);
    h.status.delete(GMAIL.id);
    h.ports.dispatch = async (id) => {
      setTimeout(() => h.finish(id, 1), 20);
      return { ok: true, triggered: 1 };
    };
    const co = new SyncNowCoordinator(h.ports);
    const res = await co.syncNow({ sourceIds: [GMAIL.id] });
    expect(res.ok).toBe(true);
    expect(res.newItems).toBe(1);
  });
});
