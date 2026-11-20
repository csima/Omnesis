// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SyncError } from "@omnesis/types";
import { KondoClient } from "./client.js";
import { grantState, readGrant, StoredTokens, writeGrant } from "./credentials.js";
import { FakeKondo, ISSUER, OWNER_URN } from "./fake-kondo.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function stored(fake: FakeKondo, expiresAt?: number) {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-kondo-"));
  dirs.push(dir);
  const grant = fake.issueGrant();
  await writeGrant(
    OWNER_URN,
    {
      client_id: grant.clientId,
      token_endpoint: `${ISSUER}/oauth/token`,
      access_token: grant.accessToken,
      refresh_token: grant.refreshToken,
      ...(expiresAt !== undefined ? { expires_at: new Date(expiresAt).toISOString() } : {}),
    },
    dir,
  );
  return { dir, grant };
}

describe("StoredTokens", () => {
  test("a rejected token is renewed and the rotated refresh token is written before use", async () => {
    const fake = new FakeKondo();
    const { dir, grant } = await stored(fake);
    const tokens = new StoredTokens(OWNER_URN, dir, { fetchImpl: fake.fetch });
    const client = new KondoClient(tokens, { fetchImpl: fake.fetch, callGapMs: 0 });
    fake.expireAccessTokens();
    expect((await client.readStatus()).connected).toBe(true);
    const after = await readGrant(OWNER_URN, dir);
    expect(after?.access_token).not.toBe(grant.accessToken);
    expect(after?.refresh_token).not.toBe(grant.refreshToken);
    expect(await grantState(OWNER_URN, dir)).toEqual({ status: "connected" });
  });

  test("renews ahead of the stated expiry without waiting for a refusal", async () => {
    const fake = new FakeKondo();
    const { dir, grant } = await stored(fake, Date.now() + 10_000);
    const tokens = new StoredTokens(OWNER_URN, dir, { fetchImpl: fake.fetch });
    expect(await tokens.accessToken()).not.toBe(grant.accessToken);
    expect(fake.tokenRequests).toHaveLength(1);
  });

  test("concurrent refusals share one renewal", async () => {
    const fake = new FakeKondo();
    const { dir, grant } = await stored(fake);
    const tokens = new StoredTokens(OWNER_URN, dir, { fetchImpl: fake.fetch });
    const [a, b] = await Promise.all([
      tokens.refresh(grant.accessToken),
      tokens.refresh(grant.accessToken),
    ]);
    expect(a).toBe(b);
    expect(fake.tokenRequests).toHaveLength(1);
  });

  test("a refused refresh marks the grant revoked; later requests fail without asking Kondo", async () => {
    const fake = new FakeKondo();
    const { dir, grant } = await stored(fake);
    fake.refreshRefused = true;
    const tokens = new StoredTokens(OWNER_URN, dir, { fetchImpl: fake.fetch });
    const err = await tokens.refresh(grant.accessToken).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe("auth");
    expect((err as SyncError).remediation?.summary).toBe("Sign in to Kondo again");
    expect(await grantState(OWNER_URN, dir)).toMatchObject({ status: "revoked" });
    await expect(tokens.accessToken()).rejects.toMatchObject({ kind: "auth" });
    expect(fake.tokenRequests).toHaveLength(1);
  });

  test("an unreachable token endpoint is a network failure and leaves the grant connected", async () => {
    const fake = new FakeKondo();
    const { dir, grant } = await stored(fake);
    const tokens = new StoredTokens(OWNER_URN, dir, {
      fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(tokens.refresh(grant.accessToken)).rejects.toMatchObject({ kind: "network" });
    expect(await grantState(OWNER_URN, dir)).toEqual({ status: "connected" });
  });

  test("credential state answers from storage: none, connected, expired without a refresh token", async () => {
    const fake = new FakeKondo();
    const { dir } = await stored(fake);
    expect(await grantState("100000999", dir)).toEqual({ status: "never-connected" });
    expect(await grantState(OWNER_URN, dir)).toEqual({ status: "connected" });
    await writeGrant(
      OWNER_URN,
      {
        client_id: "c",
        token_endpoint: `${ISSUER}/oauth/token`,
        access_token: "a",
        expires_at: "2026-01-01T00:00:00.000Z",
      },
      dir,
    );
    expect(await grantState(OWNER_URN, dir)).toMatchObject({ status: "expired" });
  });

  test("two accounts keep separate grants", async () => {
    const fake = new FakeKondo();
    const { dir, grant } = await stored(fake);
    await writeGrant(
      "100000055",
      { client_id: "other", token_endpoint: `${ISSUER}/oauth/token`, access_token: "other-token" },
      dir,
    );
    expect((await readGrant(OWNER_URN, dir))?.access_token).toBe(grant.accessToken);
    expect((await readGrant("100000055", dir))?.access_token).toBe("other-token");
  });
});
