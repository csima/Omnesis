// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readProviderAccountCredentials, writeProviderAccountCredentials } from "@omnesis/core";
import { AccountId, ProviderId } from "@omnesis/types";
import { AuthFailure, type AuthSession } from "@omnesis/source-sdk";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { FAKE_API_KEY, FAKE_ORG_ID, FAKE_ORG_NAME, FakeQuo } from "./fake-quo.js";
import {
  authenticate,
  cleanupCredentials,
  discoverAccounts,
  loadConnection,
  QUO_FILE_KEY,
} from "./provider.js";
import quoProvider from "./index.js";

const created: string[] = [];
afterEach(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
  created.length = 0;
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-quo-"));
  created.push(dir);
  return dir;
}

function session(
  answer: Record<string, string>,
  overrides: Partial<AuthSession> & { configDir?: string } = {},
) {
  const { configDir = tempConfigDir(), ...rest } = overrides;
  const shown: string[] = [];
  const asked: string[] = [];
  const s: AuthSession = {
    reason: rest.accountId ? "reauthenticate" : "connect",
    flowId: "flow-1",
    supplied: {},
    host: { ...fakeProviderHost(), configDir },
    canShow: () => true,
    show: (c) => void shown.push(c.title),
    ask: (c) => {
      asked.push(c.title);
      return Promise.resolve(answer as never);
    },
    ...rest,
  };
  return { session: s, shown, asked, configDir };
}

async function rejection(promise: Promise<unknown>): Promise<AuthFailure> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AuthFailure);
  return err as AuthFailure;
}

const fake = new FakeQuo();
const opts = { fetchImpl: fake.fetch, minSpacingMs: 0 };

describe("connecting a workspace", () => {
  test("the descriptor connects through the typed session", () => {
    expect(typeof quoProvider.authenticate).toBe("function");
    expect(quoProvider.authType).toBe("api-key");
  });

  test("asks for the key, checks it, and stores it under the organization", async () => {
    const { session: s, asked, shown, configDir } = session({ api_key: ` ${FAKE_API_KEY} ` });

    const result = await authenticate(s, opts);

    expect(asked).toEqual(["Connect a Quo workspace"]);
    expect(shown).toEqual(["Checking the API key"]);
    expect(result.accounts).toEqual([{ accountId: FAKE_ORG_ID, state: { status: "connected" } }]);
    await expect(
      readProviderAccountCredentials(QUO_FILE_KEY, FAKE_ORG_ID, configDir),
    ).resolves.toEqual({
      api_key: FAKE_API_KEY,
      organization_name: FAKE_ORG_NAME,
    });
    await expect(loadConnection(FAKE_ORG_ID, configDir)).resolves.toEqual({
      apiKey: FAKE_API_KEY,
      organizationName: FAKE_ORG_NAME,
    });
  });

  test("a key supplied up front is used without asking again", async () => {
    const { session: s, asked } = session({}, { supplied: { api_key: FAKE_API_KEY } });
    await authenticate(s, opts);
    expect(asked).toEqual([]);
  });

  test("a key Quo rejects is credential-rejected with a remedy, and nothing is stored", async () => {
    const { session: s, configDir } = session({ api_key: "Bearer wrong" });
    const err = await rejection(authenticate(s, opts));
    expect(err.code).toBe("credential-rejected");
    expect(err.remedy).toContain("without a Bearer prefix");
    expect(discoverAccounts(configDir)).toEqual([]);
  });

  test("Quo being down is unavailable, not a rejected key", async () => {
    const down = new FakeQuo();
    down.outage = 503;
    const { session: s } = session({ api_key: FAKE_API_KEY });
    const err = await rejection(
      authenticate(s, { fetchImpl: down.fetch, minSpacingMs: 0, sleep: () => Promise.resolve() }),
    );
    expect(err.code).toBe("unavailable");
  });

  test("re-authenticating with another workspace's key is refused", async () => {
    const { session: s, configDir } = session(
      { api_key: FAKE_API_KEY },
      { accountId: "ORotherws01" },
    );
    const err = await rejection(authenticate(s, opts));
    expect(err.code).toBe("identity-mismatch");
    expect(discoverAccounts(configDir)).toEqual([]);
  });

  test("re-authenticating the same workspace replaces its key", async () => {
    const configDir = tempConfigDir();
    await writeProviderAccountCredentials(QUO_FILE_KEY, FAKE_ORG_ID, { api_key: "old" }, configDir);
    const { session: s, asked } = session(
      { api_key: FAKE_API_KEY },
      { accountId: FAKE_ORG_ID, configDir },
    );
    await authenticate(s, opts);
    expect(asked).toEqual([`Reconnect ${FAKE_ORG_ID}`]);
    expect((await loadConnection(FAKE_ORG_ID, configDir)).apiKey).toBe(FAKE_API_KEY);
  });
});

describe("accounts on disk", () => {
  test("discovery is offline and lists each workspace as an opaque, tenant-scoped account", async () => {
    const configDir = tempConfigDir();
    await writeProviderAccountCredentials(QUO_FILE_KEY, "ORfirst0001", { api_key: "a" }, configDir);
    await writeProviderAccountCredentials(QUO_FILE_KEY, "ORsecond002", { api_key: "b" }, configDir);
    const accounts = await quoProvider.discover!({ configDir });
    expect(accounts).toEqual(
      expect.arrayContaining([
        {
          id: "ORfirst0001",
          subject: { kind: "opaque", value: "ORfirst0001" },
          tenant: { id: "ORfirst0001" },
        },
        {
          id: "ORsecond002",
          subject: { kind: "opaque", value: "ORsecond002" },
          tenant: { id: "ORsecond002" },
        },
      ]),
    );
  });

  test("two workspaces keep separate keys, and removing one leaves the other", async () => {
    const configDir = tempConfigDir();
    await writeProviderAccountCredentials(
      QUO_FILE_KEY,
      "ORfirst0001",
      { api_key: "key-a" },
      configDir,
    );
    await writeProviderAccountCredentials(
      QUO_FILE_KEY,
      "ORsecond002",
      { api_key: "key-b" },
      configDir,
    );
    const host = { ...fakeProviderHost(), configDir };
    const a = await quoProvider.createContext!({
      accountId: AccountId("ORfirst0001"),
      providerId: ProviderId("quo:ORfirst0001"),
      host,
    });
    const b = await quoProvider.createContext!({
      accountId: AccountId("ORsecond002"),
      providerId: ProviderId("quo:ORsecond002"),
      host,
    });
    expect(a.client).not.toBe(b.client);
    expect(a.accountId).toBe("ORfirst0001");

    await cleanupCredentials("ORfirst0001", configDir);
    expect(discoverAccounts(configDir).map((d) => d.id)).toEqual(["ORsecond002"]);
    expect((await loadConnection("ORsecond002", configDir)).apiKey).toBe("key-b");
  });

  test("the credential state answers from storage, never from Quo", async () => {
    const configDir = tempConfigDir();
    const state = (accountId: string) =>
      quoProvider.credentialState!({
        accountId,
        configDir,
        client: undefined as never,
      } as never);
    await expect(state(FAKE_ORG_ID)).resolves.toEqual({ status: "never-connected" });
    await writeProviderAccountCredentials(QUO_FILE_KEY, FAKE_ORG_ID, { api_key: "k" }, configDir);
    await expect(state(FAKE_ORG_ID)).resolves.toEqual({ status: "connected" });
  });

  test("a missing key is named when the context is created", async () => {
    const configDir = tempConfigDir();
    await expect(
      quoProvider.createContext!({
        accountId: AccountId(FAKE_ORG_ID),
        providerId: ProviderId(`quo:${FAKE_ORG_ID}`),
        host: { ...fakeProviderHost(), configDir },
      }),
    ).rejects.toThrow(/Quo/);
  });
});
