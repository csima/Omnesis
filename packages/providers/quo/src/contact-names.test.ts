// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { SyncError } from "@omnesis/types";
import { QuoClient } from "./client.js";
import { contactName, QuoContactNames } from "./contact-names.js";
import { DAVID, FAKE_API_KEY, FakeQuo, JAMIE, MAYA } from "./fake-quo.js";

function setup() {
  const fake = new FakeQuo();
  let now = Date.UTC(2026, 9, 15, 12);
  const warnings: string[] = [];
  const client = new QuoClient(FAKE_API_KEY, {
    fetchImpl: fake.fetch,
    minSpacingMs: 0,
    sleep: () => Promise.resolve(),
  });
  const names = new QuoContactNames(client, () => now, {
    warn: (m) => warnings.push(m),
    debug: () => undefined,
  });
  const searches = () => fake.requests.filter((r) => r.startsWith("/contacts/search")).length;
  return {
    fake,
    names,
    warnings,
    searches,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("contactName", () => {
  test("joins first and last name, falls back to the company, and is empty for neither", () => {
    const base = { id: "CT1", properties: [] };
    expect(contactName({ ...base, firstName: "Maya", lastName: "Reeves" })).toBe("Maya Reeves");
    expect(contactName({ ...base, firstName: " Maya ", lastName: null })).toBe("Maya");
    expect(contactName({ ...base, company: "Stellar Sound" })).toBe("Stellar Sound");
    expect(contactName({ ...base, firstName: "", lastName: " ", company: null })).toBeUndefined();
  });
});

describe("QuoContactNames", () => {
  test("names the numbers the workspace's contacts carry, in one search", async () => {
    const { fake, names, searches } = setup();
    fake.addContact({ firstName: "Maya", lastName: "Reeves", phones: [MAYA] });
    fake.addContact({ company: "Stellar Sound", phones: [JAMIE, "+15550100999"] });

    const found = await names.namesFor([MAYA, JAMIE, DAVID, MAYA]);

    expect(Object.fromEntries(found)).toEqual({ [MAYA]: "Maya Reeves", [JAMIE]: "Stellar Sound" });
    expect(searches()).toBe(1);
    expect(fake.requests.at(-1)).toContain(`phoneNumber[in]=${MAYA},${JAMIE},${DAVID}`);
    expect(fake.requests.at(-1)).toContain("include=properties");
  });

  test("remembers names and misses for hours, then asks again", async () => {
    const { fake, names, searches, advance } = setup();
    fake.addContact({ firstName: "Maya", phones: [MAYA] });

    await names.namesFor([MAYA, DAVID]);
    await names.namesFor([MAYA, DAVID]);
    expect(searches()).toBe(1);

    fake.addContact({ firstName: "David", lastName: "Lin", phones: [DAVID] });
    advance(6 * 60 * 60_000);
    const later = await names.namesFor([MAYA, DAVID]);
    expect(searches()).toBe(2);
    expect(later.get(DAVID)).toBe("David Lin");
  });

  test("a number two contacts name differently gets no name; the same name twice is kept", async () => {
    const { fake, names } = setup();
    fake.addContact({ firstName: "Maya", lastName: "Reeves", phones: [MAYA] });
    fake.addContact({ firstName: "Sarah", lastName: "Mendez", phones: [MAYA] });
    fake.addContact({ firstName: "Jamie", lastName: "Lopez", phones: [JAMIE] });
    fake.addContact({ firstName: "Jamie", lastName: "Lopez", phones: [JAMIE] });

    const found = await names.namesFor([MAYA, JAMIE]);

    expect(found.has(MAYA)).toBe(false);
    expect(found.get(JAMIE)).toBe("Jamie Lopez");
  });

  test("looks numbers up in batches of 25", async () => {
    const { names, searches } = setup();
    const numbers = Array.from({ length: 60 }, (_, i) => `+1555010${String(i).padStart(4, "0")}`);

    await names.namesFor(numbers);

    expect(searches()).toBe(3);
  });

  test("a key that may not read contacts indexes without names, and stops asking for an hour", async () => {
    const { fake, names, warnings, searches, advance } = setup();
    fake.addContact({ firstName: "Maya", phones: [MAYA] });
    fake.failNext.push({ match: "/contacts/search", status: 403 });

    await expect(names.namesFor([MAYA])).resolves.toEqual(new Map());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("without names");

    await names.namesFor([MAYA]);
    expect(searches()).toBe(1);

    advance(60 * 60_000);
    await expect(names.namesFor([MAYA])).resolves.toEqual(new Map([[MAYA, "Maya"]]));
  });

  test("a Quo outage fails the lookup, so no text is indexed without the name a retry gives it", async () => {
    const { fake, names } = setup();
    fake.outage = 503;

    const err = await names.namesFor([MAYA]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe("transient");
  });
});
