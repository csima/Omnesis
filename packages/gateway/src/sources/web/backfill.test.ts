// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { rmSync, unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeContentHash } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { AnalyticsDb } from "../../analytics-db.js";
import { redactStoredWebPages, redactStoredWebVisits } from "./backfill.js";
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

describe("redactStoredWebPages", () => {
  it("redacts stored web pages once, rehashing only those whose text changed", () => {
    plant(
      "web",
      "a",
      `Runbook ${TOKEN}`,
      `Deploy with ${TOKEN} today.`,
      "https://wiki.example.org/a",
    );
    plant("web", "b", "Clean page", "Nothing secret here.", "https://wiki.example.org/b");
    plant("web:alt", "c", "Alt", `Body ${TOKEN}`, "https://wiki.example.org/c?api_key=k");
    plant(
      "notes",
      "d",
      `Note ${TOKEN}`,
      `My own note keeps ${TOKEN}.`,
      "https://notes.example.org/d",
    );

    expect(redactStoredWebPages(db)).toBe(3);

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

    const c = row("c");
    expect(c.content).toBe("Body [redacted]");
    expect(c.source_url).toBe("https://wiki.example.org/c");

    // Another source's documents are the user's own records.
    expect(row("d").content).toBe(`My own note keeps ${TOKEN}.`);

    const before = row("a").updated_at;
    expect(redactStoredWebPages(db)).toBe(0);
    expect(row("a").updated_at).toBe(before);
  });

  it("pages through more web documents than one read holds", () => {
    for (let i = 0; i < 450; i++) {
      plant(
        "web",
        `p-${String(i).padStart(4, "0")}`,
        `Page ${i}`,
        "Plain text.",
        `https://x.example.org/${i}`,
      );
    }
    plant("web", "p-9999", "Last", `Body ${TOKEN}`, "https://x.example.org/last");
    expect(redactStoredWebPages(db)).toBe(451);
    expect(row("p-9999").content).toBe("Body [redacted]");
  });
});

describe("redactStoredWebVisits", () => {
  let analyticsPath: string;
  let analyticsDb: AnalyticsDb;
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
    analyticsPath = `/tmp/omnesis-web-backfill-test-${randomUUID()}.duckdb`;
    analyticsDb = new AnalyticsDb(analyticsPath);
    await analyticsDb.open();
  });

  afterEach(async () => {
    await analyticsDb.close();
    rmSync(analyticsPath, { force: true });
    rmSync(`${analyticsPath}.wal`, { force: true });
  });

  it("redacts stored visit titles and labels across pages, leaving every other column, once", async () => {
    const records = Array.from({ length: 1_100 }, (_, i) => ({
      url: `https://x.example.org/${i}`,
      title: i === 1_050 ? `Runbook ${TOKEN}` : `Page ${i}`,
      browser_profile_label: i === 3 ? `Work ${TOKEN}` : "Personal",
      visited_at: "2026-01-15T10:00:00Z",
      dwell_ms: 6_000 + i,
    }));
    await analyticsDb.ingestPage({ tableName: "page_visits", records, schema, sourceId: "web" });

    expect(await redactStoredWebVisits(analyticsDb)).toBe(2);
    const rows = (
      await analyticsDb.executeQuery(
        "SELECT url, title, browser_profile_label, dwell_ms FROM page_visits WHERE url IN ('https://x.example.org/1050', 'https://x.example.org/3') ORDER BY url",
        { limit: 10 },
      )
    ).rows;
    expect(rows.map((r) => [String(r[0]), String(r[1]), String(r[2]), Number(r[3])])).toEqual([
      ["https://x.example.org/1050", "Runbook [redacted]", "Personal", 7_050],
      ["https://x.example.org/3", "Page 3", "Work [redacted]", 6_003],
    ]);
    const count = (await analyticsDb.executeQuery("SELECT COUNT(*) FROM page_visits")).rows;
    expect(Number(count[0]![0])).toBe(1_100);
    expect(await redactStoredWebVisits(analyticsDb)).toBe(0);
  });

  it("does nothing when there is no page_visits table", async () => {
    expect(await redactStoredWebVisits(analyticsDb)).toBe(0);
  });
});
