// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { computeContentHash } from "@omnesis/core";
import {
  DEFAULT_WEB_CAPTURE_RULES,
  type WebCapturePolicy,
} from "@omnesis/provider-web/capture-policy";
import { SCOPE_WRITE_ALL, SourceType, writeScope } from "@omnesis/types";
import {
  assertCanonicalWebSourceIds,
  filterCapturableVisits,
  partitionCapturableDocuments,
  redactWebDocuments,
  redactWebVisitRecords,
} from "./ingest.js";
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

describe("the web source type, whatever its account suffix", () => {
  it("redacts documents and visit rows of web:<account> too, and matches the table in any case", () => {
    const [out] = redactWebDocuments([doc("web:alt", `Token ${TOKEN}`, `Body ${TOKEN}`)]);
    expect(out!.title).toBe("Token [redacted]");
    expect(out!.content).toBe("Body [redacted]");
    expect(redactWebVisitRecords("web:alt", "Page_Visits", [{ title: `T ${TOKEN}` }])).toEqual([
      { title: "T [redacted]" },
    ]);
  });

  it("refuses a web:<account> source id from a browser token, and lets a broad writer through", () => {
    const browser = [writeScope(SourceType("web"))];
    expect(() => assertCanonicalWebSourceIds(browser, ["web:alt"])).toThrow(/"web" source/);
    expect(() => assertCanonicalWebSourceIds(browser, ["web"])).not.toThrow();
    expect(() => assertCanonicalWebSourceIds(browser, ["gmail:a@example.com"])).not.toThrow();
    expect(() => assertCanonicalWebSourceIds([SCOPE_WRITE_ALL], ["web:alt"])).not.toThrow();
  });
});

describe("redaction of addresses and metadata", () => {
  it("strips credentials from a page's address, tags and extra metadata", () => {
    const page = doc("web", "Callback", "Nothing secret in the body.");
    page.metadata = {
      documentType: "webpage",
      sourceUrl: "https://maya:hunter-two@app.example.com/#/cb?access_token=abc&tab=2",
      tags: [`tag ${TOKEN}`],
      extra: { browserProfileLabel: `Work ${TOKEN}`, browserDeviceId: "d-1" },
      description: `Summary with ${TOKEN}`,
      people: [{ name: `Maker ${TOKEN}` }],
    } as unknown as DocumentInput["metadata"];
    const [out] = redactWebDocuments([page]);
    const metadata = out!.metadata as unknown as Record<string, unknown>;
    expect(metadata.sourceUrl).toBe("https://app.example.com/#/cb?tab=2");
    expect(metadata.tags).toEqual(["tag [redacted]"]);
    expect(metadata.documentType).toBe("webpage");
    expect(metadata.description).toBe("Summary with [redacted]");
    expect(metadata.people).toEqual([{ name: "Maker [redacted]" }]);
    expect(metadata.extra).toEqual({
      browserProfileLabel: "Work [redacted]",
      browserDeviceId: "d-1",
    });
    expect(out!.contentHash).toBe(page.contentHash);
  });

  it("strips credentials from a visit's address and browser label", () => {
    const [row] = redactWebVisitRecords("web", "page_visits", [
      {
        url: "https://app.example.com/x?api_key=k&id=1",
        title: "Page",
        browser_profile_label: `Work ${TOKEN}`,
      },
    ]);
    expect(row).toEqual({
      url: "https://app.example.com/x?id=1",
      title: "Page",
      browser_profile_label: "Work [redacted]",
    });
  });
});

describe("the capture policy on ingest", () => {
  const policy: WebCapturePolicy = {
    updatedAt: "",
    pause: { until: null },
    excludedDomains: ["bank.example"],
    ownedDomains: ["notes.example"],
    ownSites: ["agents.example.net"],
    rules: DEFAULT_WEB_CAPTURE_RULES,
    removedPages: [],
    removedPagesTruncated: false,
  };
  function at(url: string, sourceId = "web"): DocumentInput {
    const page = doc(sourceId, "Page", "Body");
    page.externalId = url;
    page.metadata = { documentType: "webpage", sourceUrl: url } as DocumentInput["metadata"];
    return page;
  }

  it("refuses built-in sites, own sites, excluded and owned domains and credential paths, and ignores the pause", () => {
    const refusedUrls = [
      "https://vault.bitwarden.com/#/vault",
      "https://agents.example.net/browser",
      "https://online.bank.example/statements",
      "https://notes.example/page",
      "https://code.example.org/settings/tokens",
      "https://www.linkedin.com/messaging/thread/1",
      "not a url",
      "ftp://files.example.org/report",
    ];
    const keptUrls = ["https://blog.example.org/post"];
    const { kept, refused } = partitionCapturableDocuments(
      [...refusedUrls, ...keptUrls].map((url) => at(url)),
      policy,
    );
    expect(refused.map((page) => page.externalId)).toEqual(refusedUrls);
    expect(kept.map((page) => page.externalId)).toEqual(keptUrls);
  });

  it("refuses a web page with no http(s) address even without a policy", () => {
    const missing = at("https://blog.example.org/x");
    missing.metadata = { documentType: "webpage" } as DocumentInput["metadata"];
    const { kept, refused } = partitionCapturableDocuments(
      [missing, at("javascript:alert(1)"), at("https://blog.example.org/ok")],
      null,
    );
    expect(refused).toHaveLength(2);
    expect(kept.map((page) => page.externalId)).toEqual(["https://blog.example.org/ok"]);
  });

  it("judges web:<account> pages too, and never another source's documents", () => {
    const { refused } = partitionCapturableDocuments(
      [at("https://agents.example.net/a", "web:alt"), at("https://agents.example.net/b", "notes")],
      policy,
    );
    expect(refused.map((page) => page.externalId)).toEqual(["https://agents.example.net/a"]);
  });

  it("drops refused visit rows and keeps the rest", () => {
    const rows = [{ url: "https://agents.example.net/x" }, { url: "https://blog.example.org/y" }];
    expect(filterCapturableVisits("web", "page_visits", rows, policy)).toEqual([rows[1]]);
    expect(filterCapturableVisits("web", "other", rows, policy)).toBe(rows);
    expect(filterCapturableVisits("web", "page_visits", rows, null)).toEqual(rows);
    expect(
      filterCapturableVisits("web", "page_visits", [{ url: "mailto:a@example.com" }], null),
    ).toEqual([]);
  });
});
