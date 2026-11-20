// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveSourceState } from "@omnesis/source-sdk";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { ProviderId, SourceId } from "@omnesis/types";
import { KondoClient } from "./client.js";
import { MemoryTokens } from "./credentials.js";
import { FakeKondo, ISSUER, JAMIE, MAYA, OWNER, OWNER_URN, msg } from "./fake-kondo.js";
import { KondoSource } from "./source.js";
import { kondoStateSpec } from "./state.js";
import provider, { kondoDocumentProfile } from "./index.js";
import type { DocumentInput } from "@omnesis/types";

function get(doc: DocumentInput, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  }, doc.metadata);
}

describe("Kondo descriptor contract", () => {
  const entry = provider.sources[0];

  test("one experimental OAuth source with a complete icon and no URL pattern", () => {
    expect(provider.provider).toEqual({ id: "kondo", name: "Kondo" });
    expect(provider.authType).toBe("oauth");
    expect(provider.experimental).toBe(true);
    expect(provider.sources.map((s) => s.id)).toEqual(["kondo"]);
    expect(entry.unitName).toBe("conversations");
    expect(entry.defaultSyncInterval).toBe("15m");
    expect(entry.icon).toMatchObject({
      sfSymbol: expect.any(String),
      color: expect.stringMatching(/^#/),
      bgColor: expect.stringMatching(/^#/),
      imageDataUri: expect.stringContaining("data:image/svg+xml;base64,"),
    });
    expect(Buffer.from(entry.icon!.imageDataUri!.split(",")[1], "base64").toString()).toContain(
      "<svg",
    );
    expect(entry.urlPatterns).toBeUndefined();
    expect(entry.selfIdentity).toEqual({ aliasPrefix: "linkedin", accountPattern: "^[0-9]+$" });
    expect(entry.contract).toMatchObject({ apiVersion: 2, outputRevision: 1 });
  });

  test("declares exactly the types, roles and fields the real sync path emits", async () => {
    const fake = new FakeKondo();
    fake.addChat({
      threadKey: "t-group",
      participants: [OWNER, MAYA, JAMIE],
      labelKeys: ["lbl-hiring"],
      messages: [
        msg(MAYA, "2026-03-08T09:00:00.000Z", "Kickoff"),
        msg("self", "2026-03-08T09:05:00.000Z", "Thanks both"),
      ],
    });
    const grant = fake.issueGrant();
    const source = new KondoSource({
      client: new KondoClient(
        new MemoryTokens(
          { accessToken: grant.accessToken },
          `${ISSUER}/oauth/token`,
          grant.clientId,
        ),
        { fetchImpl: fake.fetch, callGapMs: 0 },
      ),
      providerId: ProviderId(`kondo:${OWNER_URN}`),
      sourceId: SourceId(`kondo:${OWNER_URN}`),
      ownerUrn: OWNER_URN,
      now: () => Date.parse("2026-03-10T00:00:00.000Z"),
    });
    const docs: DocumentInput[] = [];
    let cursor = null;
    for (let i = 0; i < 20; i++) {
      const page = await source.sync(cursor);
      docs.push(...page.documents);
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    expect(docs).toHaveLength(1);
    const [doc] = docs;
    expect(entry.documentEventProfile).toBe(kondoDocumentProfile);
    expect(kondoDocumentProfile.documentTypes).toEqual([doc.metadata.documentType]);
    expect(kondoDocumentProfile.personRoles).toEqual([
      ...new Set(doc.metadata.people!.map((p) => p.role)),
    ]);
    for (const field of kondoDocumentProfile.metadataFields ?? []) {
      expect(get(doc, field.path), field.path).toBeDefined();
    }
    expect(get(doc, "extra.isGroup")).toBe(true);
    expect(get(doc, "extra.messageCount")).toBe(2);
    expect(doc.metadata.people?.[0].lids).toContain(`linkedin:${OWNER_URN}`);
  });

  test("decodes settled and in-progress state and refuses a newer envelope", () => {
    const settled = { v: 1, watermark: 1000 };
    const pending = {
      v: 1,
      watermark: 1000,
      pass: {
        floor: 1000,
        target: 2000,
        inbox: "archive",
        before: 1500,
        boundary: ["t"],
        pending: [{ profileUrn: OWNER_URN, threadKey: "t", activityAt: 1200, archived: true }],
        labels: { "lbl-hiring": "Hiring" },
      },
    };
    expect(kondoStateSpec.decode(settled)).toEqual(settled);
    expect(kondoStateSpec.decode(pending)).toEqual(pending);
    expect(kondoStateSpec.decode({ v: 2 })).toBeNull();
    expect(resolveSourceState(kondoStateSpec, { e: 1, v: 1, state: pending })).toMatchObject({
      kind: "resume",
      state: pending,
    });
    expect(resolveSourceState(kondoStateSpec, { e: 1, v: 2, state: settled })).toMatchObject({
      kind: "refused",
    });
    expect(kondoStateSpec.onUnreadable).toBe("rebootstrap");
  });

  test("two accounts get separate contexts that read separate grants", async () => {
    const host = fakeProviderHost({ configDir: join(tmpdir(), `omnesis-kondo-${randomUUID()}`) });
    const a = await provider.createContext!({
      accountId: "100000001",
      providerId: ProviderId("kondo:100000001"),
      host,
    });
    const b = await provider.createContext!({
      accountId: "100000002",
      providerId: ProviderId("kondo:100000002"),
      host,
    });
    expect(a.accountId).toBe("100000001");
    expect(b.accountId).toBe("100000002");
    expect(a.client).not.toBe(b.client);
    expect(await provider.credentialState!(a)).toEqual({ status: "never-connected" });
  });

  test("the history setting defaults to a year and is the only setting", () => {
    const fields = entry.config!.fields as Record<string, unknown>;
    expect(Object.keys(fields)).toEqual(["historyDays"]);
    expect(fields.historyDays).toMatchObject({ default: 365, min: 1 });
  });
});
