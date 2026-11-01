// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { computeContentHash } from "@omnesis/core";
import { redactWebDocuments, redactWebVisitRecords } from "./redact.js";
import type { DocumentInput } from "@omnesis/types";

/** Invented credential, assembled at run time so no scanner matches this file. */
const TOKEN = ["gh", "p_", "Q7rT2mX9pL4vN8kB3cZ6wY1hJ5dF0sGaAbCd"].join("");

function doc(sourceId: string, title: string, content: string): DocumentInput {
  return {
    providerId: sourceId,
    sourceId,
    externalId: `id-${sourceId}`,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: { documentType: "webpage" },
  } as unknown as DocumentInput;
}

describe("redactWebDocuments", () => {
  it("redacts a web page's title and content and rehashes the redacted text", () => {
    const [out] = redactWebDocuments([
      doc("web", `Token ${TOKEN}`, `Copy the deploy token ${TOKEN} into the fictional runner.`),
    ]);
    expect(out!.title).toBe("Token [redacted]");
    expect(out!.content).toBe("Copy the deploy token [redacted] into the fictional runner.");
    expect(out!.contentHash).toBe(computeContentHash(out!.content));
  });

  it("returns an already-clean page as the same object, hash included", () => {
    const clean = doc("web", "Field notes", "A fictional logbook entry with nothing secret in it.");
    clean.contentHash = "client-hash";
    const [out] = redactWebDocuments([clean]);
    expect(out).toBe(clean);
  });

  it("keeps the client's hash when only the title changed", () => {
    const page = doc("web", `Token ${TOKEN}`, "Nothing secret in the body.");
    page.contentHash = "client-hash";
    const [out] = redactWebDocuments([page]);
    expect(out!.title).toBe("Token [redacted]");
    expect(out!.contentHash).toBe("client-hash");
  });

  it("leaves every other source's documents exactly as written", () => {
    const note = doc("notes", `Token ${TOKEN}`, `The token is ${TOKEN}.`);
    const [out] = redactWebDocuments([note]);
    expect(out).toBe(note);
  });
});

describe("redactWebVisitRecords", () => {
  it("redacts page titles in the web source's page_visits rows", () => {
    const records = [{ url: "https://a.example/", title: `Token ${TOKEN}` }, { title: null }];
    expect(redactWebVisitRecords("web", "page_visits", records)).toEqual([
      { url: "https://a.example/", title: "Token [redacted]" },
      { title: null },
    ]);
  });

  it("leaves other tables and sources alone", () => {
    const records = [{ title: `Token ${TOKEN}` }];
    expect(redactWebVisitRecords("web", "other_table", records)).toBe(records);
    expect(redactWebVisitRecords("health", "page_visits", records)).toBe(records);
    expect(redactWebVisitRecords(undefined, "page_visits", records)).toBe(records);
  });
});
