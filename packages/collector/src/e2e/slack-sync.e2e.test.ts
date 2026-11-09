// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import "./synth-env.js";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

// Fictional fixtures exercise discovery and the real daily normalizer through
// collector ingestion. They do not certify Slack authentication or UI parity.
describe("Slack synthetic collector ingestion", () => {
  let harness: SyntheticE2EHarness;
  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "synthetic", universe: "e2e-minimal" });
    await harness.start();
    expect(harness.getSourceIds()).toContain("slack:TEXAMPLE-USELF00");
    await harness.triggerSyncAndWait("slack:TEXAMPLE-USELF00", 90_000);
  }, 120_000);
  afterAll(async () => {
    await harness?.destroy();
  });

  test("stores the daily document, people and exact outgoing permalink", () => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      const rows = db
        .prepare("SELECT external_id, content, metadata FROM documents WHERE source_id = ?")
        .all("slack:TEXAMPLE-USELF00") as {
        external_id: string;
        content: string;
        metadata: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].external_id).toBe("CEXAMPLE:2026-05-19");
      expect(rows[0].content).toContain("fictional workshop checklist");
      const metadata = JSON.parse(rows[0].metadata);
      expect(metadata.sourceUrl).toBe(
        "https://example-workshop.slack.com/archives/CEXAMPLE/p1779184800000000",
      );
      expect(metadata.people).toEqual(
        expect.arrayContaining([expect.objectContaining({ lids: ["slack:TEXAMPLE-UOTHER0"] })]),
      );
    } finally {
      db.close();
    }
  });
});
