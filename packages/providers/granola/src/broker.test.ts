// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrokeredCredentials,
  brokerBindingPath,
  writeBrokerBinding,
  writeCredentialBrokerConfig,
  writeProviderCredentials,
} from "@omnesis/core";
import { ProviderId } from "@omnesis/types";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { verifyGranolaIdentity } from "./provider.js";
import definition from "./index.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const BROKER = { kind: "nango" as const, url: "http://127.0.0.1:3999", secretKey: "broker-key" };
const REF = { providerConfigKey: "granola", connectionId: "conn-granola" };
const ACCOUNT = "maya.reeves@example.com";

async function brokeredConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-granola-broker-"));
  tmpDirs.push(dir);
  await writeCredentialBrokerConfig(BROKER, dir);
  await writeBrokerBinding(
    "granola",
    ACCOUNT,
    { broker: "nango", connections: { default: REF } },
    dir,
  );
  return dir;
}

/**
 * The broker hands out each of `keys` in turn (the last one thereafter);
 * Granola accepts only `accepted` and lists `notes` for it.
 */
function stubNetwork(opts: { keys: string[]; accepted?: string; notes?: unknown[] }) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  let served = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      calls.push({ url, authorization });
      if (url.startsWith(BROKER.url)) {
        const apiKey = opts.keys[Math.min(served++, opts.keys.length - 1)]!;
        return Promise.resolve(Response.json({ credentials: { type: "API_KEY", apiKey } }));
      }
      if (authorization !== `Bearer ${opts.accepted ?? opts.keys[0]}`) {
        return Promise.resolve(
          Response.json({ code: "INVALID_API_KEY", message: "Invalid API key" }, { status: 401 }),
        );
      }
      const notes = opts.notes ?? [{ id: "not_1", owner: { name: "Maya Reeves", email: ACCOUNT } }];
      return Promise.resolve(Response.json({ notes, hasMore: false, cursor: null }));
    }),
  );
  return calls;
}

async function brokeredContext(configDir: string) {
  return definition.createContext!({
    accountId: ACCOUNT,
    providerId: ProviderId(`granola:${ACCOUNT}`),
    host: fakeProviderHost({ configDir }),
  });
}

function credentialsFor(): BrokeredCredentials {
  return new BrokeredCredentials({ broker: "nango", connections: { default: REF } }, BROKER);
}

describe("Granola with a brokered key", () => {
  test("discovers the brokered account with no key on disk", async () => {
    const configDir = await brokeredConfigDir();
    expect(existsSync(join(configDir, "granola-credentials.json"))).toBe(false);
    await expect(definition.discover!({ configDir })).resolves.toEqual([
      { id: ACCOUNT, subject: { kind: "email", value: ACCOUNT } },
    ]);
  });

  test("calls Granola with the key the broker hands out, and stores none", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({ keys: ["grn_brokered_key"] });
    const context = await brokeredContext(configDir);
    await context.client.listNotes();

    const broker = calls.filter((c) => c.url.startsWith(BROKER.url));
    const granola = calls.filter((c) => c.url.startsWith("https://public-api.granola.ai"));
    expect(broker[0]!.authorization).toBe("Bearer broker-key");
    expect(granola.length).toBeGreaterThan(0);
    for (const call of granola) expect(call.authorization).toBe("Bearer grn_brokered_key");
    expect(readdirSync(join(configDir, "granola", ACCOUNT))).toEqual(["broker.json"]);
  });

  test("asks the broker again once when Granola rejects a key it rotated", async () => {
    const configDir = await brokeredConfigDir();
    const network = { keys: ["grn_old_key", "grn_new_key"], accepted: "grn_old_key" };
    const calls = stubNetwork(network);
    const context = await brokeredContext(configDir);
    await expect(context.client.listNotes()).resolves.toMatchObject({ hasMore: false });
    network.accepted = "grn_new_key";
    await expect(context.client.listNotes()).resolves.toMatchObject({ hasMore: false });
    expect(calls.filter((c) => c.url.startsWith(BROKER.url))).toHaveLength(2);
  });

  test("still reports a key Granola keeps rejecting as an auth failure", async () => {
    const configDir = await brokeredConfigDir();
    stubNetwork({ keys: ["grn_revoked_key"], accepted: "grn_other_key" });
    const context = await brokeredContext(configDir);
    await expect(context.client.listNotes()).rejects.toMatchObject({ kind: "auth" });
  });

  test("is connected while the binding reads, and never-connected once it is removed", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({ keys: ["grn_k"] });
    const context = await brokeredContext(configDir);
    await expect(definition.credentialState!(context)).resolves.toEqual({ status: "connected" });
    await definition.cleanupCredentials!(ACCOUNT, { configDir });
    expect(existsSync(brokerBindingPath("granola", ACCOUNT, configDir))).toBe(false);
    await expect(definition.credentialState!(context)).resolves.toEqual({
      status: "never-connected",
    });
    // Nothing upstream is touched: the key is the broker's.
    expect(calls).toEqual([]);
  });

  test("removing a brokered account leaves an older install's shared key alone", async () => {
    const configDir = await brokeredConfigDir();
    await writeProviderCredentials("granola", { api_key: "grn_fictional" }, configDir);
    await definition.cleanupCredentials!(ACCOUNT, { configDir });
    expect(existsSync(join(configDir, "granola-credentials.json"))).toBe(true);
  });

  test("resolves the account to the owner's email, as a paste of the key would", async () => {
    stubNetwork({ keys: ["grn_brokered_key"] });
    await expect(definition.broker!.resolveAccount(credentialsFor(), {})).resolves.toEqual({
      accountId: ACCOUNT,
    });
  });

  test("resolves a workspace with no notes yet to the fingerprint of the key", async () => {
    stubNetwork({ keys: ["grn_empty_key"], notes: [] });
    const fingerprint = createHash("sha256").update("grn_empty_key").digest("hex").slice(0, 12);
    await expect(definition.broker!.resolveAccount(credentialsFor(), {})).resolves.toEqual({
      accountId: `granola-${fingerprint}`,
    });
  });
});

describe("a brokered Granola key is re-checked against the linked account", () => {
  const granolaCalls = (calls: ReturnType<typeof stubNetwork>) =>
    calls.filter((c) => c.url.startsWith("https://public-api.granola.ai"));
  const note = (id: string, email: string) => ({ id, owner: { name: "Someone", email } });

  test("a key whose notes include the owner's syncs, asking once per key", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({
      keys: ["grn_brokered_key"],
      notes: [note("not_2", "olu.bassey@example.com"), note("not_1", "Maya.Reeves@example.com")],
    });
    const context = await brokeredContext(configDir);
    await context.client.listNotes();
    await context.client.listNotes();
    expect(granolaCalls(calls).map((c) => new URL(c.url).searchParams.get("page_size"))).toEqual([
      "30",
      "20",
      "20",
    ]);
  });

  test("a key of another Granola user stops with identity-changed before any note is read", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({
      keys: ["grn_swapped_key"],
      notes: [note("not_9", "jamie.lopez@example.org")],
    });
    const context = await brokeredContext(configDir);
    const failure = await context.client.listNotes().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toMatchObject({
      name: "BrokerCredentialError",
      reason: "identity-changed",
      kind: "auth",
    });
    expect((failure as Error).message).not.toContain("jamie.lopez");
    expect(granolaCalls(calls)).toHaveLength(1);
    expect(readdirSync(join(configDir, "granola", ACCOUNT))).toEqual(["broker.json"]);
  });

  test("a key that lists no notes cannot be confirmed, is refused, and is asked about again", async () => {
    const result = {
      credential: { type: "api-key" as const, apiKey: "grn_empty_key" },
      connectionConfig: {},
      metadata: {},
    };
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ notes: [], hasMore: false, cursor: null })),
    );
    const verify = verifyGranolaIdentity(ACCOUNT, { fetchImpl: fetchImpl as typeof fetch });
    for (let i = 0; i < 2; i++) {
      await expect(verify("default", result)).rejects.toMatchObject({
        reason: "identity-changed",
        message: expect.stringContaining("cannot confirm"),
      });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("a fingerprint account accepts only the key it was named after", async () => {
    const fingerprint = `granola-${createHash("sha256").update("grn_linked_key").digest("hex").slice(0, 12)}`;
    const fetchImpl = vi.fn(() => Promise.reject(new Error("no request expected")));
    const verify = verifyGranolaIdentity(fingerprint, { fetchImpl: fetchImpl as typeof fetch });
    const result = (apiKey: string) => ({
      credential: { type: "api-key" as const, apiKey },
      connectionConfig: {},
      metadata: {},
    });
    await expect(verify("default", result(" grn_linked_key "))).resolves.toBeUndefined();
    await expect(verify("default", result("grn_other_key"))).rejects.toMatchObject({
      reason: "identity-changed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("a check Granola fails keeps its kind and is never taken as a match", async () => {
    const result = {
      credential: { type: "api-key" as const, apiKey: "grn_brokered_key" },
      connectionConfig: {},
      metadata: {},
    };
    const failing = (respond: () => Promise<Response>) =>
      verifyGranolaIdentity(ACCOUNT, { fetchImpl: respond as typeof fetch, sleep: async () => {} });
    await expect(
      failing(() => Promise.reject(new TypeError("fetch failed")))("default", result),
    ).rejects.toMatchObject({ kind: "network" });
    await expect(
      failing(() =>
        Promise.resolve(
          Response.json({ code: "INVALID_API_KEY", message: "Invalid API key" }, { status: 401 }),
        ),
      )("default", result),
    ).rejects.toMatchObject({ kind: "auth" });
    await expect(
      failing(() => Promise.resolve(new Response("unavailable", { status: 503 })))(
        "default",
        result,
      ),
    ).rejects.not.toMatchObject({ reason: "identity-changed" });
  });
});
