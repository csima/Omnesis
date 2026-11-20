// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { IMessagePreviewLedger } from "./imessage-preview-ledger.js";

const entry = {
  key: "attachment-guid-1",
  externalId: "chat-1:2026-03-04/att/a1b2c3d4",
  dayKey: "chat-1:2026-03-04",
  fileSignature: "file:2048:1000",
};

let dir: string | undefined;
let ledger: IMessagePreviewLedger | undefined;

afterEach(() => {
  ledger?.close();
  ledger = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function open(): IMessagePreviewLedger {
  dir = mkdtempSync(join(tmpdir(), "imessage-preview-ledger-"));
  ledger = new IMessagePreviewLedger(join(dir, "state", "imessage-previews.db"));
  return ledger;
}

describe("IMessagePreviewLedger", () => {
  test("is a private file holding only the schedule", () => {
    open();
    expect(statSync(join(dir!, "state", "imessage-previews.db")).mode & 0o777).toBe(0o600);
  });

  test("a stored or refused file is not offered again until it changes", () => {
    const l = open();
    expect(l.shouldOffer(entry.key, entry.fileSignature, 0)).toBe(true);
    l.markOffered(entry, 0);
    l.record(entry.key, entry.fileSignature, "stored");
    expect(l.stateOf(entry.key)).toBe("stored");
    expect(l.shouldOffer(entry.key, entry.fileSignature, 10 ** 12)).toBe(false);
    expect(l.shouldOffer(entry.key, "file:2048:2000", 0)).toBe(true);

    l.markOffered({ ...entry, fileSignature: "file:2048:2000" }, 0);
    l.record(entry.key, "file:2048:2000", "refused");
    expect(l.shouldOffer(entry.key, "file:2048:2000", 10 ** 12)).toBe(false);
  });

  test("an offer in flight is deferred on a schedule that backs off, and due() returns it", () => {
    const l = open();
    l.markOffered(entry, 0);
    expect(l.stateOf(entry.key)).toBe("deferred");
    expect(l.shouldOffer(entry.key, entry.fileSignature, 59_999)).toBe(false);
    expect(l.due(59_999, 10)).toEqual([]);
    expect(l.due(60_000, 10)).toEqual([entry]);
    l.record(entry.key, entry.fileSignature, "deferred");
    l.markOffered(entry, 60_000);
    expect(l.due(60_000 + 299_999, 10)).toEqual([]);
    expect(l.due(60_000 + 300_000, 10)).toEqual([entry]);
  });

  test("waiting entries are due at once without counting an attempt", () => {
    const l = open();
    l.markWaiting(entry, 5_000);
    expect(l.due(5_000, 10)).toEqual([entry]);
    l.markOffered(entry, 5_000);
    expect(l.due(5_000 + 59_999, 10)).toEqual([]);
    expect(l.due(5_000 + 60_000, 10)).toEqual([entry]);
  });

  test("not-found drops the row, an answer about an older file is ignored, and clear forgets all", () => {
    const l = open();
    l.markOffered(entry, 0);
    l.record(entry.key, "file:1:1", "stored");
    expect(l.stateOf(entry.key)).toBe("deferred");
    l.record(entry.key, entry.fileSignature, "not-found");
    expect(l.stateOf(entry.key)).toBeUndefined();

    l.markOffered(entry, 0);
    l.clear();
    expect(l.stateOf(entry.key)).toBeUndefined();
  });
});
