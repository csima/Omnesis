// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { rmSync, unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeContentHash } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { AnalyticsDb } from "../../analytics-db.js";
import {
  WEB_PAGES_REDACTION_KEY,
  WEB_REDACTION_PAGE_SIZE,
  WEB_VISITS_REDACTION_KEY,
  WebRedactionBackfill,
  applyWebRedactionPage,
  markWebRedactionDue,
  planWebRedactionPage,
  redactStoredWebVisits,
  webRedactionIsCurrent,
} from "./backfill.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";
import type { Db } from "../../data/types.js";

/** Invented credential, assembled at run time so no scanner matches this file. */
const TOKEN = ["gh", "p_", "Q7rT2mX9pL4vN8kB3cZ6wY1hJ5dF0sGaAbCd"].join("");
const OLD = "2026-01-15T10:00:00.000Z";

let dbPath: string;
let db: Db;

beforeEach(() => {
  dbPath = `/tmp/omnesis-web-backfill-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function plant(sourceId: string, externalId: string, title: string, content: string, url: string) {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
       metadata, source_created_at, source_updated_at, ingested_at, updated_at, source_url,
       links_extracted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    sourceId === "notes" ? "notes" : "web",
    sourceId,
    externalId,
    title,
    content,
    computeContentHash(content),
    JSON.stringify({ documentType: "webpage", sourceUrl: url, tags: [`tag ${TOKEN}`] }),
    OLD,
    OLD,
    OLD,
    OLD,
    url,
    OLD,
  );
}

function row(externalId: string) {
  return db
    .prepare<
      [string],
      {
        title: string;
        content: string;
        content_hash: string;
        metadata: string;
        source_url: string;
        updated_at: string;
        links_extracted_at: string | null;
      }
    >(
      "SELECT title, content, content_hash, metadata, source_url, updated_at, links_extracted_at FROM documents WHERE external_id = ?",
    )
    .get(externalId)!;
}

/** The pass with both gates on this handle, as the gateway runs it on its reader and writer. */
function backfill(): WebRedactionBackfill {
  return new WebRedactionBackfill({
    isCurrent: () => webRedactionIsCurrent(db, WEB_PAGES_REDACTION_KEY),
    plan: (cursor) => Promise.resolve(planWebRedactionPage(db, cursor)),
    apply: (mutations, finishedKey) =>
      Promise.resolve(applyWebRedactionPage(db, mutations, finishedKey)),
  });
}

describe("migration 207", () => {
  it("only records that a pass is due, rewriting nothing in the boot transaction", () => {
    plant(
      "web",
      "a",
      `Runbook ${TOKEN}`,
      `Deploy with ${TOKEN} today.`,
      "https://wiki.example.org/a",
    );
    db.prepare(
      "INSERT INTO canonicalization_state (key, value, updated_at) VALUES (?, '1', ?)",
    ).run(WEB_PAGES_REDACTION_KEY, OLD);
    markWebRedactionDue(db);
    expect(webRedactionIsCurrent(db, WEB_PAGES_REDACTION_KEY)).toBe(false);
    expect(webRedactionIsCurrent(db, WEB_VISITS_REDACTION_KEY)).toBe(false);
    expect(row("a").content).toBe(`Deploy with ${TOKEN} today.`);
  });
});

describe("WebRedactionBackfill", () => {
  it("redacts stored web pages with the shaped rules once, rehashing only changed text", async () => {
    plant(
      "web",
      "a",
      `Runbook ${TOKEN}`,
      `Deploy with ${TOKEN} today.`,
      "https://wiki.example.org/a",
    );
    plant("web", "b", "Clean page", "Nothing secret here.", "https://wiki.example.org/b");
    plant("web:alt", "c", "Alt", `Body ${TOKEN}`, "https://maya:hunter-two@wiki.example.org/c");
    plant(
      "notes",
      "d",
      `Note ${TOKEN}`,
      `My own note keeps ${TOKEN}.`,
      "https://notes.example.org/d",
    );
    plant(
      "web",
      "e",
      "Settings",
      "password: hunter-two-x is how the form spells it.",
      "https://wiki.example.org/e",
    );

    expect(await backfill().run()).toEqual({ scanned: 4, touched: 4 });

    const a = row("a");
    expect(a.title).toBe("Runbook [redacted]");
    expect(a.content).toBe("Deploy with [redacted] today.");
    expect(a.content_hash).toBe(computeContentHash(a.content));
    expect(a.metadata).not.toContain(TOKEN);
    expect(a.updated_at).not.toBe(OLD);
    expect(a.links_extracted_at).toBeNull();

    // Only its tags held a credential, so its text and hash stay.
    const b = row("b");
    expect(b.content_hash).toBe(computeContentHash("Nothing secret here."));
    expect(b.metadata).not.toContain(TOKEN);

    expect(row("c").content).toBe("Body [redacted]");
    expect(row("c").source_url).toBe("https://wiki.example.org/c");

    // Stored text gets the shaped rules only: an assignment is left as it was.
    expect(row("e").content).toBe("password: hunter-two-x is how the form spells it.");

    // Another source's documents are the user's own records.
    expect(row("d").content).toBe(`My own note keeps ${TOKEN}.`);

    expect(webRedactionIsCurrent(db, WEB_PAGES_REDACTION_KEY)).toBe(true);
    const before = row("a").updated_at;
    expect(await backfill().run()).toEqual({ scanned: 0, touched: 0 });
    expect(row("a").updated_at).toBe(before);
  });

  it("pages through more web documents than one plan holds, a bounded page per write", async () => {
    for (let i = 0; i < 130; i++) {
      plant(
        "web",
        `p-${String(i).padStart(4, "0")}`,
        `Page ${i}`,
        "Plain text.",
        `https://x.example.org/${i}`,
      );
    }
    const first = planWebRedactionPage(db);
    expect(first.mutations).toHaveLength(WEB_REDACTION_PAGE_SIZE);
    expect(first.done).toBe(false);
    expect((await backfill().run()).touched).toBe(130);
  });

  it("leaves a row that changed after it was read", () => {
    plant("web", "a", `Runbook ${TOKEN}`, `Body ${TOKEN}`, "https://wiki.example.org/a");
    const plan = planWebRedactionPage(db);
    db.prepare("UPDATE documents SET updated_at = ? WHERE external_id = 'a'").run(
      "2026-02-01T00:00:00.000Z",
    );
    expect(applyWebRedactionPage(db, plan.mutations, null)).toBe(0);
    expect(row("a").content).toBe(`Body ${TOKEN}`);
  });
});

describe("redactStoredWebVisits", () => {
  let analyticsPath: string;
  let analyticsDb: AnalyticsDb;
  let current: boolean;
  const state = {
    isCurrent: () => current,
    markCurrent: () => {
      current = true;
      return Promise.resolve();
    },
  };
  const schema: AnalyticsTableSchema = {
    tableName: "page_visits",
    displayName: "Page visits",
    description: "Invented visits",
    columns: [
      { name: "url", type: "VARCHAR", description: "Page URL", references: "url" },
      { name: "title", type: "VARCHAR", description: "Title", nullable: true },
      { name: "browser_profile_label", type: "VARCHAR", description: "Label", nullable: true },
      { name: "visited_at", type: "TIMESTAMPTZ", description: "When" },
      { name: "dwell_ms", type: "INTEGER", description: "Dwell" },
    ],
    primaryKey: ["url", "visited_at"],
    semanticTimeColumn: "visited_at",
    record: { titleColumns: ["title", "url"], keyColumns: ["url", "visited_at"] },
  };

  beforeEach(async () => {
    current = false;
    analyticsPath = `/tmp/omnesis-web-backfill-test-${randomUUID()}.duckdb`;
    analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();
  });

  afterEach(async () => {
    await analyticsDb.close();
    rmSync(analyticsPath, { force: true });
    rmSync(`${analyticsPath}.wal`, { force: true });
  });

  it("redacts titles and labels across pages and moves rows whose address held a credential, once", async () => {
    const records = Array.from({ length: 1_100 }, (_, i) => ({
      url: `https://x.example.org/${i}`,
      title: i === 1_050 ? `Runbook ${TOKEN}` : `Page ${i}`,
      browser_profile_label: i === 3 ? `Work ${TOKEN}` : "Personal",
      visited_at: "2026-01-15T10:00:00Z",
      dwell_ms: 6_000 + i,
    }));
    records.push({
      url: "https://app.example.org/#/cb?access_token=abc&tab=2",
      title: "Callback",
      browser_profile_label: "Personal",
      visited_at: "2026-01-15T11:00:00Z",
      dwell_ms: 7_000,
    });
    await analyticsDb.ingestPage({ tableName: "page_visits", records, schema, sourceId: "web" });

    expect(await redactStoredWebVisits(analyticsDb, state)).toBe(3);
    const rows = (
      await analyticsDb.executeQuery(
        "SELECT url, title, browser_profile_label, dwell_ms FROM page_visits WHERE url IN ('https://x.example.org/1050', 'https://x.example.org/3') OR title = 'Callback' ORDER BY url",
        { limit: 10 },
      )
    ).rows;
    expect(rows.map((r) => [String(r[0]), String(r[1]), String(r[2]), Number(r[3])])).toEqual([
      ["https://app.example.org/#/cb?tab=2", "Callback", "Personal", 7_000],
      ["https://x.example.org/1050", "Runbook [redacted]", "Personal", 7_050],
      ["https://x.example.org/3", "Page 3", "Work [redacted]", 6_003],
    ]);
    const count = (await analyticsDb.executeQuery("SELECT COUNT(*) FROM page_visits")).rows;
    expect(Number(count[0]![0])).toBe(1_101);
    expect(current).toBe(true);
    expect(await redactStoredWebVisits(analyticsDb, state)).toBe(0);
  });

  it("merges a moved row into a row already at its cleaned key, keeping the longer dwell and a title", async () => {
    await analyticsDb.ingestPage({
      tableName: "page_visits",
      records: [
        {
          url: "https://app.example.org/p?q=1",
          title: "",
          browser_profile_label: "Personal",
          visited_at: "2026-01-15T10:00:00Z",
          dwell_ms: 4_000,
        },
        {
          url: "https://app.example.org/p?q=1&session_token=S1x",
          title: "Report",
          browser_profile_label: "Personal",
          visited_at: "2026-01-15T10:00:00Z",
          dwell_ms: 9_000,
        },
      ],
      schema,
      sourceId: "web",
    });
    expect(await redactStoredWebVisits(analyticsDb, state)).toBe(1);
    const rows = (
      await analyticsDb.executeQuery("SELECT url, title, dwell_ms FROM page_visits", { limit: 10 })
    ).rows;
    expect(rows.map((r) => [String(r[0]), String(r[1]), Number(r[2])])).toEqual([
      ["https://app.example.org/p?q=1", "Report", 9_000],
    ]);
  });

  it("moves 20,000 rows in bounded transactions", async () => {
    const records = Array.from({ length: 20_000 }, (_, i) => ({
      url: `https://app.example.org/p/${i}?session_token=S${i}x&q=${i}`,
      title: "Doc",
      browser_profile_label: "Personal",
      visited_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      dwell_ms: 5_000,
    }));
    for (let off = 0; off < records.length; off += 5_000) {
      await analyticsDb.ingestPage({
        tableName: "page_visits",
        records: records.slice(off, off + 5_000),
        schema,
        sourceId: "web",
      });
    }
    expect(await redactStoredWebVisits(analyticsDb, state)).toBe(20_000);
    const left = (
      await analyticsDb.executeQuery(
        "SELECT count(*) FILTER (WHERE url LIKE '%session_token%'), count(*) FROM page_visits",
      )
    ).rows;
    expect(left[0]!.map(Number)).toEqual([0, 20_000]);
  }, 120_000);

  it("records the pass as done when there is no page_visits table", async () => {
    expect(await redactStoredWebVisits(analyticsDb, state)).toBe(0);
    expect(current).toBe(true);
  });
});
