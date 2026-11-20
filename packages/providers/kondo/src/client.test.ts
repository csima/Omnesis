// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { describe, expect, test } from "vitest";
import { SyncError } from "@omnesis/types";
import { KondoClient, parseToolResult, TAB_REMEDIATION } from "./client.js";
import { MemoryTokens } from "./credentials.js";
import { FakeKondo, ISSUER, MAYA, msg } from "./fake-kondo.js";

function setup(configure?: (fake: FakeKondo) => void) {
  const fake = new FakeKondo();
  fake.addChat({
    threadKey: "thread-a",
    participants: [MAYA],
    messages: [msg(MAYA, "2026-03-09T10:00:00.000Z", "Hello there")],
  });
  configure?.(fake);
  const grant = fake.issueGrant();
  const tokens = new MemoryTokens(
    { accessToken: grant.accessToken, refreshToken: grant.refreshToken },
    `${ISSUER}/oauth/token`,
    grant.clientId,
    { fetchImpl: fake.fetch },
  );
  const client = new KondoClient(tokens, { fetchImpl: fake.fetch, callGapMs: 0 });
  return { fake, client, tokens };
}

async function caught(promise: Promise<unknown>): Promise<SyncError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SyncError);
  return err as SyncError;
}

describe("KondoClient", () => {
  test("initializes once, keeps the session id and calls a tool over JSON", async () => {
    const { fake, client } = setup();
    const status = await client.readStatus();
    const page = await client.listInbox({ inbox: "all", limit: 5 });
    expect(status.connected).toBe(true);
    expect(page.rows.map((r) => r.threadKey)).toEqual(["thread-a"]);
    expect(page.more).toBe(false);
    expect(fake.toolCalls().map((c) => c.name)).toEqual(["read_status", "list_inbox"]);
    expect(fake.toolCalls("list_inbox")[0].args).toMatchObject({
      inbox: "all",
      view: "EVERYTHING",
    });
  });

  test("reads a response delivered as a server-sent event stream", async () => {
    const { client } = setup((fake) => {
      fake.sse = true;
    });
    const { chats } = await client.readChats([{ profileUrn: "100000001", threadKey: "thread-a" }]);
    expect(chats).toHaveLength(1);
    expect(chats[0].messages[0].text).toBe("Hello there");
  });

  test("works with a server that assigns no session", async () => {
    const { client } = setup((fake) => {
      fake.assignSession = false;
    });
    expect((await client.readStatus()).connected).toBe(true);
  });

  test("a 401 renews the token once and retries", async () => {
    const { fake, client, tokens } = setup();
    await client.readStatus();
    const before = tokens.tokens.accessToken;
    fake.expireAccessTokens();
    expect((await client.readStatus()).connected).toBe(true);
    expect(tokens.tokens.accessToken).not.toBe(before);
    expect(fake.tokenRequests.map((r) => r.grant_type)).toEqual(["refresh_token"]);
    expect(fake.tokenRequests[0].resource).toBe("https://relay.trykondo.com");
  });

  test("a refused refresh is an auth failure on the connection", async () => {
    const { fake, client } = setup();
    fake.expireAccessTokens();
    fake.refreshRefused = true;
    const err = await caught(client.readStatus());
    expect(err.kind).toBe("auth");
    expect(err.scope).toBe("connection");
  });

  test("a closed Kondo tab is a transient failure that names the fix", async () => {
    const { client } = setup((fake) => {
      fake.tabConnected = false;
    });
    const err = await caught(client.listInbox({ inbox: "all", limit: 5 }));
    expect(err.kind).toBe("transient");
    expect(err.remediation).toBe(TAB_REMEDIATION);
    expect(err.message).toContain("Open Kondo in one Chrome tab");
  });

  test("a refusal while the tab is connected is transient without the tab remedy", async () => {
    const { client } = setup((fake) => fake.refuse.add("list_inboxes"));
    const err = await caught(client.listLabels());
    expect(err.kind).toBe("transient");
    expect(err.remediation).toBeUndefined();
    expect(err.message).toContain("Kondo is busy");
  });

  test("maps rate limits, outages and unreachable hosts to typed failures", async () => {
    const { fake, client } = setup();
    fake.failNext.push(429);
    const limited = await caught(client.readStatus());
    expect(limited.kind).toBe("rate-limit");
    expect(limited.retryAfterMs).toBe(30_000);
    expect(limited.quota).toEqual({ kind: "account" });

    fake.failNext.push(503);
    expect((await caught(client.readStatus())).kind).toBe("transient");

    fake.failNext.push(403);
    expect((await caught(client.readStatus())).kind).toBe("permission");

    const offline = new KondoClient(
      { accessToken: () => Promise.resolve("t"), refresh: () => Promise.resolve("t") },
      {
        callGapMs: 0,
        fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
      },
    );
    expect((await caught(offline.readStatus())).kind).toBe("network");
  });

  test("starts a new session when the server forgets the old one", async () => {
    const { fake, client } = setup();
    await client.readStatus();
    fake.dropSessions();
    expect((await client.readStatus()).connected).toBe(true);
  });

  test("refuses every tool that is not read-only, before sending anything", async () => {
    const { fake, client } = setup();
    for (const name of [
      "set_label",
      "load_chat",
      "list_connections",
      "list_invites",
      "list_chats",
    ]) {
      await expect(client.callTool(name as never, {})).rejects.toThrow(/only read-only tools/);
    }
    await expect(client.callTool("list_inbox", { linkedin: true })).rejects.toThrow(/LinkedIn/);
    expect(fake.calls).toEqual([]);
    expect(fake.forbidden).toEqual([]);
  });

  test("skips malformed inbox rows and chats instead of failing the page", async () => {
    const fake = new FakeKondo();
    const grant = fake.issueGrant();
    const tokens = new MemoryTokens(
      { accessToken: grant.accessToken },
      `${ISSUER}/oauth/token`,
      grant.clientId,
    );
    const original = fake.fetch;
    const patched: typeof fetch = async (input, init) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { params?: { name?: string } })
        : {};
      if (body.params?.name === "list_inbox") {
        const result = {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                data: [
                  { threadKey: "no-owner" },
                  { profileUrn: 1, threadKey: "ok", threadActivityAt: 5 },
                ],
              }),
            },
          ],
        };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result }), {
          headers: { "content-type": "application/json" },
        });
      }
      return original(input, init);
    };
    const patchedClient = new KondoClient(tokens, { callGapMs: 0, fetchImpl: patched });
    const page = await patchedClient.listInbox({ inbox: "all", limit: 5 });
    expect(page.rows).toEqual([{ profileUrn: "1", threadKey: "ok", threadActivityAt: 5 }]);
    expect(page.skipped).toBe(1);
  });
});

describe("parseToolResult", () => {
  test("separates the JSON block from the hints and reads the paging hint", () => {
    const result = parseToolResult({
      content: [
        { type: "text", text: JSON.stringify({ ok: true, data: [1] }) },
        { type: "text", text: "More results may be available" },
      ],
    });
    expect(result).toEqual({ ok: true, data: [1], hints: ["More results may be available"] });
  });

  test("carries the error of a refusal and of an isError result", () => {
    expect(
      parseToolResult({
        content: [
          { type: "text", text: JSON.stringify({ ok: false, error: { message: "nope" } }) },
        ],
      }),
    ).toMatchObject({ ok: false, error: "nope" });
    expect(
      parseToolResult({
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ ok: true, data: 1 }) }],
      }).ok,
    ).toBe(false);
    expect(parseToolResult({ content: [{ type: "text", text: "plain failure" }] })).toMatchObject({
      ok: false,
      error: "plain failure",
    });
  });
});
