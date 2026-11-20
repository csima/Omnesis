// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AuthFailure } from "@omnesis/source-sdk";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { grantState, readGrant } from "./credentials.js";
import { FakeKondo, MAYA, OWNER, OWNER_URN, SUBJECT, msg } from "./fake-kondo.js";
import { authenticateWith, cleanupCredentials, discoverAccounts } from "./provider.js";
import type { AskableChallenge, AuthChallenge, AuthSession } from "@omnesis/source-sdk";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function configDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-kondo-"));
  dirs.push(dir);
  return dir;
}

/** What the browser does with a loopback redirect: request it, and nothing else. */
function browse(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

function populatedFake(): FakeKondo {
  const fake = new FakeKondo();
  fake.addChat({
    threadKey: "t-maya",
    participants: [OWNER, MAYA],
    messages: [msg(MAYA, "2026-03-08T09:00:00.000Z", "Hello")],
  });
  return fake;
}

function scriptedSession(options: {
  configDir: string;
  answer: (challenge: AskableChallenge) => Promise<{ code: string; state?: string }>;
  accountId?: string;
  publicBaseUrl?: string;
}) {
  const shown: AuthChallenge[] = [];
  const asked: AskableChallenge[] = [];
  const session: AuthSession = {
    reason: options.accountId ? "reauthenticate" : "connect",
    flowId: "flow-1",
    accountId: options.accountId,
    publicBaseUrl: options.publicBaseUrl,
    supplied: {},
    host: { ...fakeProviderHost(), configDir: options.configDir },
    canShow: () => true,
    show: (challenge) => void shown.push(challenge),
    ask: (challenge) => {
      asked.push(challenge);
      return options.answer(challenge) as never;
    },
  };
  return { session, shown, asked };
}

const never = () => new Promise<never>(() => {});

/** Approve in the "browser" and let the loopback listener catch the redirect. */
function viaLoopback(fake: FakeKondo, opts: { deny?: boolean } = {}) {
  return (challenge: AskableChallenge) => {
    if (challenge.kind !== "redirect") throw new Error("expected a redirect");
    void browse(fake.approve(challenge.url, opts));
    return never();
  };
}

/** Approve in the "browser" and hand the code back through the host, as a paste or the gateway does. */
function pasted(fake: FakeKondo) {
  return (challenge: AskableChallenge) => {
    if (challenge.kind !== "redirect") throw new Error("expected a redirect");
    const back = new URL(fake.approve(challenge.url));
    return Promise.resolve({
      code: back.searchParams.get("code")!,
      state: back.searchParams.get("state")!,
    });
  };
}

const deps = (fake: FakeKondo) => ({
  fetchImpl: fake.fetch,
  client: { callGapMs: 0 },
  tabPollMs: 1,
  tabWaitMs: 1_000,
  sleep: () => Promise.resolve(),
});

async function failureFrom(promise: Promise<unknown>): Promise<AuthFailure> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AuthFailure);
  return err as AuthFailure;
}

describe("signing in to Kondo", () => {
  test("loopback: registers a client for an ephemeral port, signs in with PKCE and stores the grant", async () => {
    const dir = await configDir();
    const fake = populatedFake();
    const { session, asked, shown } = scriptedSession({
      configDir: dir,
      answer: viaLoopback(fake),
    });

    const result = await authenticateWith(session, deps(fake));

    expect(result.accounts).toEqual([{ accountId: OWNER_URN, state: { status: "connected" } }]);
    const challenge = asked[0];
    expect(challenge).toMatchObject({ kind: "redirect", via: "loopback" });
    const url = new URL((challenge as { url: string }).url);
    expect(url.origin + url.pathname).toBe("https://supa.trykondo.com/auth/v1/oauth/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("https://relay.trykondo.com");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(Number(redirect.port)).toBeGreaterThan(0);
    expect(fake.registrations[0].body).toMatchObject({ token_endpoint_auth_method: "none" });
    expect(shown.map((c) => c.kind)).toEqual(["wait"]);

    const grant = await readGrant(OWNER_URN, dir);
    expect(grant).toMatchObject({
      client_id: fake.registrations[0].clientId,
      token_endpoint: "https://supa.trykondo.com/auth/v1/oauth/token",
      label: "Sarah Mendez",
    });
    expect(grant?.refresh_token).toMatch(/^refresh-/);
    expect(discoverAccounts(dir)).toEqual([OWNER_URN]);
    expect(await grantState(OWNER_URN, dir)).toEqual({ status: "connected" });
    expect(fake.forbidden).toEqual([]);
  });

  test("two sign-ins at once each get their own port", async () => {
    const fake = populatedFake();
    const [a, b] = await Promise.all([configDir(), configDir()]);
    await Promise.all([
      authenticateWith(
        scriptedSession({ configDir: a, answer: viaLoopback(fake) }).session,
        deps(fake),
      ),
      authenticateWith(
        scriptedSession({ configDir: b, answer: viaLoopback(fake) }).session,
        deps(fake),
      ),
    ]);
    const ports = fake.registrations.map((r) => new URL(r.redirectUris[0]).port);
    expect(new Set(ports).size).toBe(2);
  });

  test("gateway: the redirect returns to the gateway with the flow id as state", async () => {
    const dir = await configDir();
    const fake = populatedFake();
    const { session, asked } = scriptedSession({
      configDir: dir,
      publicBaseUrl: "https://gateway.example.com/",
      answer: pasted(fake),
    });
    const result = await authenticateWith(session, deps(fake));
    expect(result.accounts[0].accountId).toBe(OWNER_URN);
    const url = new URL((asked[0] as { url: string }).url);
    expect(asked[0]).toMatchObject({ via: "gateway" });
    expect(url.searchParams.get("state")).toBe("flow-1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://gateway.example.com/oauth/callback");
  });

  test("a pasted redirect answers the loopback challenge too", async () => {
    const dir = await configDir();
    const fake = populatedFake();
    const { session } = scriptedSession({
      configDir: dir,
      answer: pasted(fake),
    });
    expect((await authenticateWith(session, deps(fake))).accounts[0].accountId).toBe(OWNER_URN);
  });

  test("waits for a Kondo tab, telling the operator to open one", async () => {
    const dir = await configDir();
    const fake = populatedFake();
    fake.tabConnected = false;
    let polls = 0;
    const { session, shown } = scriptedSession({ configDir: dir, answer: viaLoopback(fake) });
    const result = await authenticateWith(session, {
      ...deps(fake),
      sleep: () => {
        if (++polls === 2) fake.tabConnected = true;
        return Promise.resolve();
      },
    });
    expect(result.accounts[0].accountId).toBe(OWNER_URN);
    expect(shown.map((c) => c.title)).toContain("Open Kondo in one Chrome tab");
  });

  test("no tab before the deadline fails as unavailable and stores nothing", async () => {
    const dir = await configDir();
    const fake = populatedFake();
    fake.tabConnected = false;
    const { session } = scriptedSession({ configDir: dir, answer: viaLoopback(fake) });
    const failure = await failureFrom(authenticateWith(session, { ...deps(fake), tabWaitMs: 0 }));
    expect(failure.code).toBe("unavailable");
    expect(failure.remedy).toContain("Chrome tab");
    expect(discoverAccounts(dir)).toEqual([]);
  });

  test("a declined consent is `denied` and stores nothing", async () => {
    const dir = await configDir();
    const fake = populatedFake();
    const { session } = scriptedSession({
      configDir: dir,
      answer: viaLoopback(fake, { deny: true }),
    });
    expect((await failureFrom(authenticateWith(session, deps(fake)))).code).toBe("denied");
    expect(await readdir(dir)).toEqual([]);
  });

  test("re-authenticating with another LinkedIn inbox is refused and stores nothing", async () => {
    const dir = await configDir();
    const fake = populatedFake();
    const { session } = scriptedSession({
      configDir: dir,
      accountId: "100000777",
      answer: viaLoopback(fake),
    });
    const failure = await failureFrom(authenticateWith(session, deps(fake)));
    expect(failure.code).toBe("identity-mismatch");
    expect(discoverAccounts(dir)).toEqual([]);
  });

  test("an empty inbox falls back to the Kondo user as the account", async () => {
    const dir = await configDir();
    const fake = new FakeKondo();
    const { session } = scriptedSession({ configDir: dir, answer: viaLoopback(fake) });
    const result = await authenticateWith(session, deps(fake));
    expect(result.accounts[0].accountId).toBe(`user-${SUBJECT}`);
  });

  test("Kondo unreachable at discovery is `unavailable`", async () => {
    const dir = await configDir();
    const { session } = scriptedSession({ configDir: dir, answer: never });
    const failure = await failureFrom(
      authenticateWith(session, {
        fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
      }),
    );
    expect(failure.code).toBe("unavailable");
  });

  test("cleanup removes only that account", async () => {
    const fake = populatedFake();
    const dir = await configDir();
    await authenticateWith(
      scriptedSession({ configDir: dir, answer: viaLoopback(fake) }).session,
      deps(fake),
    );
    const other = new FakeKondo();
    other.addChat({
      threadKey: "t-x",
      profileUrn: "100000055",
      participants: [MAYA],
      messages: [msg(MAYA, "2026-03-08T09:00:00.000Z", "Hi")],
    });
    await authenticateWith(
      scriptedSession({ configDir: dir, answer: viaLoopback(other) }).session,
      deps(other),
    );
    expect(discoverAccounts(dir).sort()).toEqual(["100000001", "100000055"]);
    await cleanupCredentials("100000055", dir);
    expect(discoverAccounts(dir)).toEqual([OWNER_URN]);
    expect(await grantState("100000055", dir)).toEqual({ status: "never-connected" });
  });
});
