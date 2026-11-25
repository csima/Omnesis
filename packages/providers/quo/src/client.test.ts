// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { SyncError } from "@omnesis/types";
import { parseRetryAfterMs, QuoClient } from "./client.js";
import { FAKE_API_KEY, FAKE_ORG_ID, FAKE_ORG_NAME, FakeQuo, MAIN_LINE } from "./fake-quo.js";

function client(fake: FakeQuo, sleeps: number[] = [], key = FAKE_API_KEY) {
  return new QuoClient(key, {
    fetchImpl: fake.fetch,
    minSpacingMs: 0,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
}

async function failure(promise: Promise<unknown>): Promise<SyncError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SyncError);
  return err as SyncError;
}

describe("QuoClient", () => {
  test("sends the key as-is, without a Bearer prefix, and pins the API version", async () => {
    let seen: Headers | undefined;
    const fake = new FakeQuo();
    const c = new QuoClient(FAKE_API_KEY, {
      minSpacingMs: 0,
      fetchImpl: (input, init) => {
        seen = new Headers(init?.headers);
        return fake.fetch(input, init);
      },
    });
    await c.getOrganization();
    expect(seen?.get("authorization")).toBe(FAKE_API_KEY);
    expect(seen?.get("quo-api-version")).toBe("2026-03-30");
  });

  test("reads the organization the key belongs to", async () => {
    await expect(client(new FakeQuo()).getOrganization()).resolves.toEqual({
      id: FAKE_ORG_ID,
      name: FAKE_ORG_NAME,
    });
  });

  test("walks every page of phone numbers", async () => {
    const fake = new FakeQuo();
    for (let i = 0; i < 60; i++) {
      fake.phoneNumbers.push({
        id: `PNextra${i}`,
        phoneNumber: `+1555010${String(300 + i).padStart(4, "0")}`,
        name: `Line ${i}`,
      });
    }
    const numbers = await client(fake).listPhoneNumbers();
    expect(numbers).toHaveLength(62);
    expect(numbers[0]).toEqual(MAIN_LINE);
  });

  test("sends the createdAt range as Quo's bracketed filters", async () => {
    const fake = new FakeQuo();
    await client(fake).listMessages({
      createdAfter: "2026-10-01T00:00:00.000Z",
      createdBefore: "2026-10-02T00:00:00.000Z",
    });
    expect(fake.requests).toEqual([
      "/messages?limit=50&createdAt[gt]=2026-10-01T00:00:00.000Z&createdAt[lt]=2026-10-02T00:00:00.000Z",
    ]);
  });

  test("counts records that fail the schema instead of failing the page", async () => {
    const fake = new FakeQuo();
    fake.add({ direction: "incoming" });
    fake.addRaw({ id: "ACbad", createdAt: "2026-10-01T09:30:00Z" });
    const page = await client(fake).listMessages({});
    expect(page.messages.map((m) => m.id)).toEqual(["ACmsg0001"]);
    expect(page.malformed).toBe(1);
  });

  test("a wrong key is an auth failure for the whole connection", async () => {
    const err = await failure(client(new FakeQuo(), [], "wrong-key").listMessages({}));
    expect(err.kind).toBe("auth");
    expect(err.scope).toBe("connection");
    expect(err.message).toContain("HTTP 401");
    expect(err.message).toContain("trace 1234567890");
    expect(err.message).not.toContain("wrong-key");
  });

  test("a 400 names Quo's own reason", async () => {
    const fake = new FakeQuo();
    fake.failNext.push({
      match: "/messages",
      status: 400,
      body: JSON.stringify({ title: "Bad Request", message: "Validation failed for 1 field." }),
    });
    const err = await failure(client(fake).listMessages({}));
    expect(err.kind).toBe("unknown");
    expect(err.message).toContain("Validation failed for 1 field.");
  });

  test("429 without Retry-After backs off and retries, then reports the rate limit", async () => {
    const fake = new FakeQuo();
    const sleeps: number[] = [];
    for (let i = 0; i < 3; i++) fake.failNext.push({ match: "/messages", status: 429 });
    const err = await failure(client(fake, sleeps).listMessages({}));
    expect(err.kind).toBe("rate-limit");
    expect(sleeps).toEqual([1000, 2000]);
    expect(err.retryAfterMs).toBe(4000);
  });

  test("5xx retries twice with doubling backoff before it is transient", async () => {
    const fake = new FakeQuo();
    const sleeps: number[] = [];
    for (let i = 0; i < 3; i++) fake.failNext.push({ match: "/messages", status: 502 });
    const err = await failure(client(fake, sleeps).listMessages({}));
    expect(err.kind).toBe("transient");
    expect(sleeps).toEqual([1000, 2000]);
  });

  test("an unreachable host is a network failure", async () => {
    const c = new QuoClient(FAKE_API_KEY, {
      minSpacingMs: 0,
      fetchImpl: () => Promise.reject(new Error("getaddrinfo ENOTFOUND api.quo.com")),
    });
    expect((await failure(c.listMessages({}))).kind).toBe("network");
  });

  test("a body that is not JSON is refused at the boundary", async () => {
    const fake = new FakeQuo();
    fake.failNext.push({ match: "/messages", status: 200, body: "<html>sign in</html>" });
    expect((await failure(client(fake).listMessages({}))).kind).toBe("unknown");
  });

  test("requests are spaced to stay under ten a second", async () => {
    const fake = new FakeQuo();
    const sleeps: number[] = [];
    let now = 0;
    const c = new QuoClient(FAKE_API_KEY, {
      fetchImpl: fake.fetch,
      now: () => now,
      sleep: (ms) => {
        sleeps.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });
    await c.listMessages({});
    await c.listMessages({});
    await c.listMessages({});
    expect(sleeps).toEqual([120, 120]);
  });
});

describe("parseRetryAfterMs", () => {
  test("reads seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    expect(parseRetryAfterMs("3", now)).toBe(3000);
    expect(parseRetryAfterMs("Thu, 01 Oct 2026 00:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfterMs("soon", now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });
});
