// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { describe, it, expect } from "vitest";
import { SlackClient } from "./client.js";
import { readPositions } from "./read-positions.js";
import { CREDENTIAL, FakeSlack, IDENTITY } from "./fake-slack.js";
describe("read-marker coverage", () => {
  it("requests official markers only for DMs, group DMs and recently active conversations", async () => {
    const fake = new FakeSlack();
    const client = new SlackClient(CREDENTIAL, { fetchImpl: fake.fetch, paceMs: 0 });
    const conversations = [
      { id: "CQUIET00", is_member: true },
      { id: "CACTIVE0", is_member: true },
      { id: "DEXAMPLE", is_im: true },
      { id: "GEXAMPLE", is_mpim: true },
    ];
    fake.conversations = conversations;
    const rows = await readPositions(
      client,
      false,
      conversations,
      IDENTITY,
      "TEXAMPLE-USELF00",
      0,
      new Set(["CACTIVE0"]),
    );
    expect(fake.calls.map((c) => c.params.get("channel"))).toEqual([
      "CACTIVE0",
      "DEXAMPLE",
      "GEXAMPLE",
    ]);
    expect(rows).toHaveLength(3);
  });
  it("keeps only explicit markers, with separate thread markers, without writes", async () => {
    const fake = new FakeSlack();
    fake.markers = [
      {
        id: "CEXAMPLE",
        last_read: "1779184800.000000",
        threads: [{ thread_ts: "1779184700.000000", last_read: "1779184900.000000" }],
      },
      { id: "CUNKNOWN", mention_count: 3 },
    ];
    const rows = await readPositions(
      new SlackClient(CREDENTIAL, { fetchImpl: fake.fetch, paceMs: 0 }),
      true,
      [
        { id: "CEXAMPLE", is_member: true },
        { id: "CUNKNOWN", is_member: true },
      ],
      IDENTITY,
      "TEXAMPLE-USELF00",
      0,
      new Set(),
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0].thread_reads))).toEqual({
      "1779184700.000000": "1779184900.000000",
    });
    expect(fake.calls.map((c) => c.method)).toEqual(["client.counts"]);
  });
});
