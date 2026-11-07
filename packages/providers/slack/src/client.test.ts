// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { describe, it, expect } from "vitest";
import { SlackClient } from "./client.js";
import { CREDENTIAL, FakeSlack } from "./fake-slack.js";
import { slackTs } from "./types.js";
describe("Slack read client", () => {
  it("pins oldest/latest to exactly six decimals, including fractional milliseconds", async () => {
    expect(slackTs(1_800_000_123_456)).toBe("1800000123.456000");
    const server = new FakeSlack();
    const client = new SlackClient(CREDENTIAL, { fetchImpl: server.fetch, paceMs: 0 });
    await client.call("conversations.history", {
      oldest: slackTs(1_800_000_000_000),
      latest: slackTs(1_800_000_123_456),
    });
    expect(server.calls[0].params.get("oldest")).toMatch(/^\d+\.\d{6}$/);
    expect(server.calls[0].params.get("latest")).toMatch(/^\d+\.\d{6}$/);
    await expect(
      client.call("conversations.history", { oldest: "1800000000.0000000" }),
    ).rejects.toThrow();
    expect(server.calls).toHaveLength(1);
  });
  it.each([
    "chat.postMessage",
    "reactions.add",
    "conversations.mark",
    "conversations.join",
    "im.open",
  ])("refuses %s before transport", async (method) => {
    const server = new FakeSlack();
    await expect(
      new SlackClient(CREDENTIAL, { fetchImpl: server.fetch }).call(method),
    ).rejects.toMatchObject({ kind: "permission" });
    expect(server.calls).toHaveLength(0);
  });
  it("never follows a credential redirect and limits sessions to the validated workspace host", async () => {
    const server = new FakeSlack();
    await new SlackClient(
      { ...CREDENTIAL, cookie: "fictional-cookie", userAgent: "Exact fictional UA" },
      { fetchImpl: server.fetch, paceMs: 0 },
    ).call("auth.test");
    expect(server.calls[0]).toMatchObject({
      redirect: "error",
      url: "https://example-workshop.slack.com/api/auth.test",
    });
    expect(
      () =>
        new SlackClient({
          ...CREDENTIAL,
          identity: { ...CREDENTIAL.identity, url: "https://slack.com.evil.example/" },
        }),
    ).toThrow();
  });
  it("surfaces Retry-After without retrying", async () => {
    const server = new FakeSlack();
    server.rateLimit = true;
    await expect(
      new SlackClient(CREDENTIAL, { fetchImpl: server.fetch }).call("auth.test"),
    ).rejects.toMatchObject({ kind: "rate-limit", retryAfterMs: 3000, quota: { kind: "account" } });
    expect(server.calls).toHaveLength(1);
  });
  it("paces each method by its Slack tier instead of one global gap", async () => {
    const server = new FakeSlack();
    let now = 0;
    const waits: number[] = [];
    const client = new SlackClient(CREDENTIAL, {
      fetchImpl: server.fetch,
      now: () => now,
      pause: (ms) => {
        waits.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });
    await client.call("users.list");
    await client.call("users.list", { cursor: "2" });
    await client.call("conversations.history", { channel: "CEXAMPLE" });
    await client.call("conversations.history", { channel: "CSECOND" });
    expect(waits).toEqual([3000, 1200]);
  });
  it("replays a page's completed reads after a rate limit until the page settles", async () => {
    const server = new FakeSlack();
    const client = new SlackClient(CREDENTIAL, { fetchImpl: server.fetch, paceMs: 0 });
    await client.call("usergroups.list", { include_users: "true" });
    server.rateLimit = true;
    await expect(client.call("auth.test")).rejects.toMatchObject({ kind: "rate-limit" });
    await client.call("usergroups.list", { include_users: "true" });
    expect(server.calls.filter((c) => c.method === "usergroups.list")).toHaveLength(1);
    client.settle();
    await client.call("usergroups.list", { include_users: "true" });
    expect(server.calls.filter((c) => c.method === "usergroups.list")).toHaveLength(2);
  });
  it("never exposes transport or server secrets in errors", async () => {
    const client = new SlackClient(CREDENTIAL, {
      fetchImpl: () => Promise.reject(new Error("secret-cookie-value")),
    });
    await expect(client.call("auth.test")).rejects.toMatchObject({
      message: "Slack request failed; retry on the next cycle",
      cause: undefined,
    });
  });
  it("honors cancellation", async () => {
    const server = new FakeSlack();
    const ac = new AbortController();
    ac.abort();
    await expect(
      new SlackClient(CREDENTIAL, { fetchImpl: server.fetch }).call("auth.test", {}, ac.signal),
    ).rejects.toThrow();
    expect(server.calls).toHaveLength(0);
  });
});
