// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { buildSyncNowBody, renderSyncNow, type SyncNowResponse } from "./sync-now.js";

describe("buildSyncNowBody", () => {
  it("sends ids, type and a timeout in milliseconds", () => {
    expect(buildSyncNowBody(["gmail:a"], "quo", 12.5)).toEqual({
      sourceIds: ["gmail:a"],
      sourceType: "quo",
      timeoutMs: 12_500,
    });
  });
  it("omits what was not given", () => {
    expect(buildSyncNowBody([], "gmail", undefined)).toEqual({ sourceType: "gmail" });
    expect(buildSyncNowBody(["a:b"], undefined, undefined)).toEqual({ sourceIds: ["a:b"] });
  });
});

describe("renderSyncNow", () => {
  const base: SyncNowResponse = {
    ok: false,
    syncedAt: null,
    lagMs: null,
    newItems: 0,
    coalesced: true,
    timedOut: true,
    elapsedMs: 1,
    sourceIds: ["a:1", "b:2"],
    unknown: ["z:9"],
    sources: [
      {
        sourceId: "a:1",
        outcome: "synced",
        syncedAt: "2026-01-01T00:00:00Z",
        lagMs: 120,
        newItems: 3,
        coalesced: true,
        cooledDown: false,
      },
      {
        sourceId: "b:2",
        outcome: "timeout",
        syncedAt: null,
        lagMs: null,
        newItems: 0,
        coalesced: false,
        cooledDown: false,
        message: "still syncing",
      },
    ],
  };
  it("lists each source, its tags, failures and unknown ids", () => {
    const out = renderSyncNow(base).join("\n");
    expect(out).toContain("a:1");
    expect(out).toContain("+3 new");
    expect(out).toContain("lag 120ms");
    expect(out).toContain("joined in-flight sync");
    expect(out).toContain("timeout: still syncing");
    expect(out).toContain("Unknown source:");
    expect(out).toContain("z:9");
  });
});
