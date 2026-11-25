// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pins the declared `documentEventProfile` to documents the real sync path
 * produces — a declared field or role nobody emits compiles a watch condition
 * that can never fire — and checks the rest of the descriptor's contract.
 */

import { describe, expect, test } from "vitest";
import {
  checkContractCompatibility,
  encodeSourceState,
  resolveSourceState,
  validateDocumentEventProfile,
} from "@omnesis/source-sdk";
import {
  fakeSourceHost,
  formatConformanceReport,
  runProviderConformance,
} from "@omnesis/source-sdk/testing";
import { ProviderId, SourceId } from "@omnesis/types";
import { QuoClient } from "./client.js";
import { FAKE_API_KEY, FAKE_ORG_ID, FakeQuo, JAMIE, MAYA } from "./fake-quo.js";
import { QuoMessagesSource } from "./source.js";
import { quoMessagesStateSpec } from "./state.js";
import quoProvider from "./index.js";
import type { DocumentMetadataFieldSpec } from "@omnesis/source-sdk";
import type { QuoCursor } from "./state.js";

const definition = quoProvider.sources[0]!;
const profile = definition.documentEventProfile!;

async function syncedDocuments() {
  const fake = new FakeQuo();
  fake.add({ direction: "incoming" });
  fake.add({ direction: "outgoing" });
  fake.add({ direction: "incoming", from: JAMIE, to: ["+15550100100", MAYA] });
  fake.add({ direction: "incoming", from: "72345" });
  const source = new QuoMessagesSource({
    client: new QuoClient(FAKE_API_KEY, { fetchImpl: fake.fetch, minSpacingMs: 0 }),
    providerId: ProviderId(`quo:${FAKE_ORG_ID}`),
    sourceId: SourceId(`quo-messages:${FAKE_ORG_ID}`),
    organizationId: FAKE_ORG_ID,
    host: fakeSourceHost({ now: new Date("2026-10-15T00:00:00Z") }),
    historyDays: 180,
  });
  return (await source.sync(null)).documents;
}

function valueAt(metadata: object, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], metadata);
}

const TYPE_CHECKS: Record<DocumentMetadataFieldSpec["type"], (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
  "string-array": (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
};

describe("quo-messages descriptor", () => {
  test("the profile is valid", () => {
    expect(() => validateDocumentEventProfile(profile, "provider-quo")).not.toThrow();
  });

  test("declares exactly the document types and roles the sync emits", async () => {
    const docs = await syncedDocuments();
    expect(profile.documentTypes).toEqual([...new Set(docs.map((d) => d.metadata.documentType))]);
    expect(new Set(profile.personRoles)).toEqual(
      new Set(docs.flatMap((d) => d.metadata.people!.map((p) => p.role))),
    );
  });

  test("every declared field is written with its declared type and values", async () => {
    const docs = await syncedDocuments();
    for (const field of profile.metadataFields ?? []) {
      const values = docs
        .map((d) => valueAt(d.metadata, field.path))
        .filter((v) => v !== undefined);
      expect(values.length, field.path).toBeGreaterThan(0);
      for (const value of values) expect(TYPE_CHECKS[field.type](value), field.path).toBe(true);
      if (field.allowedValues) {
        for (const value of values) expect(field.allowedValues, field.path).toContain(value);
      }
    }
  });

  test("every metadata field the sync writes is declared", async () => {
    const declared = new Set((profile.metadataFields ?? []).map((f) => f.path));
    for (const doc of await syncedDocuments()) {
      const written = [
        ...Object.keys(doc.metadata.extra ?? {}).map((key) => `extra.${key}`),
        ...(doc.metadata.automatedSender !== undefined ? ["automatedSender"] : []),
      ];
      for (const path of written) expect(declared.has(path), path).toBe(true);
    }
  });

  test("carries a complete icon, a unit noun, a deep-link pattern and no experimental gate", () => {
    expect(definition.icon).toEqual(
      expect.objectContaining({
        sfSymbol: expect.any(String),
        color: expect.stringMatching(/^#[0-9A-F]{6}$/i),
        bgColor: expect.stringMatching(/^#[0-9A-F]{6}$/i),
        imageDataUri: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
      }),
    );
    const svg = Buffer.from(definition.icon!.imageDataUri!.split(",")[1]!, "base64").toString();
    expect(svg).toMatch(/^<svg[\s\S]*<\/svg>$/);
    expect(definition.unitName).toBe("texts");
    expect(definition.experimental ?? false).toBe(false);
    expect(definition.urlPatterns?.[0]?.regex.length).toBeLessThanOrEqual(300);
    expect(definition.selfIdentity).toEqual({
      aliasPrefix: "quo",
      accountPattern: "^OR[A-Za-z0-9]+$",
    });
    expect(new RegExp(definition.selfIdentity!.accountPattern!).test(FAKE_ORG_ID)).toBe(true);
  });

  test("declares the host generation and capabilities it needs, and an older host refuses it", () => {
    const contract = definition.contract;
    expect(contract?.apiVersion).toBe(2);
    expect(checkContractCompatibility(contract, "quo-messages")).toBeNull();
    expect(checkContractCompatibility(contract, "quo-messages", { apiVersion: 1 })?.kind).toBe(
      "api-too-new",
    );
    expect(
      checkContractCompatibility(contract, "quo-messages", { capabilities: ["state-envelope"] })
        ?.kind,
    ).toBe("missing-capability");
  });

  test("passes the contract conformance suite with settled and in-progress state", async () => {
    const reports = await runProviderConformance(quoProvider as never, {
      "quo-messages": {
        stateFixtures: {
          1: {
            v: 1,
            watermark: { at: "2026-10-01T09:00:00.000Z", ids: ["ACmsg0001"] },
            walk: { below: { at: "2026-10-05T09:00:00.000Z", ids: ["ACmsg0009"] } },
          },
          2: {
            v: 2,
            watermark: { at: "2026-10-01T09:00:00.000Z", ids: ["ACmsg0001"] },
            walk: { below: { at: "2026-10-05T09:00:00.000Z", ids: ["ACmsg0009"] } },
          },
        },
        expectMigrated: {
          1: (state) => expect(state).toEqual({ v: 2 }),
        },
        refusedStateFixtures: ["unreadable", { v: 3 }],
      },
    });
    for (const report of reports)
      expect(report.findings, formatConformanceReport(report)).toEqual([]);
  });

  test("resumes settled and pending cursors, and refuses a newer major version", () => {
    const settled: QuoCursor = { v: 2, watermark: { at: "2026-10-01T09:00:00.000Z", ids: [] } };
    const bootstrap: QuoCursor = {
      v: 2,
      walk: {
        floor: "2026-04-18T12:00:00.000Z",
        top: { at: "2026-10-01T09:00:00.000Z", ids: ["ACmsg0040"] },
        below: { at: "2026-09-01T09:00:00.000Z", ids: ["ACmsg0011", "ACmsg0012"] },
      },
    };
    for (const cursor of [settled, bootstrap]) {
      expect(
        resolveSourceState(quoMessagesStateSpec, cursor, { sourceId: "quo-messages" }),
      ).toMatchObject({
        kind: "resume",
        state: cursor,
      });
    }
    expect(
      resolveSourceState(
        quoMessagesStateSpec,
        { e: 1, v: 3, state: settled },
        { sourceId: "quo-messages" },
      ).kind,
    ).toBe("refused");
    expect(quoMessagesStateSpec.decode({ v: 2, watermark: { at: "never", ids: [] } })).toBeNull();
  });

  test("a version 1 bookmark is dropped so the history is walked again with names", () => {
    const v1 = { v: 1, watermark: { at: "2026-10-01T09:00:00.000Z", ids: ["ACmsg0001"] } };
    expect(
      resolveSourceState(
        quoMessagesStateSpec,
        { e: 1, v: 1, state: v1 },
        { sourceId: "quo-messages" },
      ),
    ).toMatchObject({ kind: "migrated", state: { v: 2 } });
  });

  test("a cursor holding thousands of ids in one millisecond fits the state ceiling", () => {
    const ids = Array.from({ length: 5_000 }, (_, i) => `ACmsg${String(i).padStart(20, "0")}`);
    const cursor: QuoCursor = {
      v: 2,
      watermark: { at: "2026-10-01T09:00:00.000Z", ids },
      walk: {
        top: { at: "2026-10-02T09:00:00.000Z", ids },
        below: { at: "2026-10-01T10:00:00.000Z", ids },
      },
    };
    const bytes = Buffer.byteLength(
      JSON.stringify(encodeSourceState(quoMessagesStateSpec, cursor)),
    );
    expect(bytes).toBeLessThan(quoMessagesStateSpec.maxBytes!);
  });
});
