// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { describe, it, expect } from "vitest";
import provider from "./index.js";
import { normalizeDay } from "./normalizer.js";
import { CHANNEL, IDENTITY } from "./fake-slack.js";
import { SourceId, ProviderId } from "@omnesis/types";
import { resolveSourceState } from "@omnesis/source-sdk";
import { slackStateSpec } from "./state.js";
describe("Slack descriptor contract", () => {
  it("loads two isolated connection modes with only session mode experimental", () => {
    expect(provider.sources.map((s) => [s.id, s.authType, s.experimental])).toEqual([
      ["slack", "api-key", false],
      ["slack-session", "local", true],
    ]);
    for (const source of provider.sources) {
      expect(source.contract).toMatchObject({ apiVersion: 2, outputRevision: 1 });
      expect(source.defaultSyncInterval).toBe("15m");
      expect(source.icon).toMatchObject({
        sfSymbol: expect.any(String),
        color: expect.any(String),
        bgColor: expect.any(String),
        imageDataUri: expect.stringContaining("data:image/svg+xml;base64,"),
      });
    }
    expect(provider.sources[0].analyticsSchemas?.map((s) => s.tableName)).not.toEqual(
      provider.sources[1].analyticsSchemas?.map((s) => s.tableName),
    );
  });
  it("declares the exact metadata fields, count semantics and people roles emitted", () => {
    const doc = normalizeDay(
      CHANNEL,
      "2026-05-19",
      [{ ts: "1779184800.000000", user: "USELF00", text: "Hi <@UOTHER0>" }],
      [
        { id: "USELF00", name: "alex" },
        { id: "UOTHER0", name: "river" },
      ],
      IDENTITY,
      {
        sourceId: SourceId("slack:TEXAMPLE-USELF00"),
        providerId: ProviderId("slack:TEXAMPLE-USELF00"),
      },
    )!;
    const profile = provider.sources[0].documentEventProfile!;
    expect(profile.documentTypes).toContain(doc.metadata.documentType);
    for (const field of profile.metadataFields ?? [])
      expect(doc.metadata.extra).toHaveProperty(field.path.replace("extra.", ""));
    expect(profile.personRoles?.sort()).toEqual(
      [...new Set(doc.metadata.people!.map((p) => p.role))].sort(),
    );
  });
  it("decodes pending and settled state without silently restarting unreadable or newer state", () => {
    const cursor = { v: 1, startedAt: 1000, channels: {} };
    expect(slackStateSpec.decode(cursor)).toEqual(cursor);
    expect(resolveSourceState(slackStateSpec, { e: 1, v: 2, state: cursor })).toMatchObject({
      kind: "refused",
    });
    expect(resolveSourceState(slackStateSpec, { e: 1, v: 1, state: cursor })).toMatchObject({
      kind: "resume",
      state: cursor,
    });
    expect(
      slackStateSpec.decode({ ...cursor, pending: { cut: 1000, deep: true, queue: [] } }),
    ).not.toBeNull();
    expect(slackStateSpec.decode({})).toBeNull();
    expect(slackStateSpec.onUnreadable).toBe("stop");
  });
});
