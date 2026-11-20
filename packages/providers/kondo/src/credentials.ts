// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

/**
 * The stored grant, and the two token sources the client is given: one that
 * lives on disk and renews itself in the background, and one held in memory
 * while a sign-in is still deciding which account it belongs to.
 *
 * Kondo's authorization server rotates refresh tokens, so a renewed grant is
 * written to disk before its access token is used. A refresh token that was
 * used once and then lost would leave the account unrenewable.
 */

import {
  createLogger,
  hasProviderAccountCredentials,
  readProviderAccountCredentials,
  writeProviderAccountCredentials,
} from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { OAuthError, refreshGrant } from "./oauth.js";
import type { ConnectionState } from "@omnesis/source-sdk";
import type { SyncRemediation } from "@omnesis/types";
import type { TokenSource } from "./client.js";
import type { OAuthDeps, TokenSet } from "./oauth.js";

const log = createLogger("provider:kondo");

export const KONDO_FILE_KEY = "kondo";

/** Renew this long before the server's stated expiry. */
const EXPIRY_MARGIN_MS = 60_000;

/** What one account keeps on disk. Every value is a string for the shared secret-file helpers. */
export interface StoredGrant {
  client_id: string;
  token_endpoint: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  scope?: string;
  /** The LinkedIn identity Kondo reported at sign-in, for the account's label. */
  label?: string;
  /** Set when Kondo refused the refresh token: the operator must sign in again. */
  revoked_at?: string;
}

export function grantFromTokens(
  tokens: TokenSet,
  base: { client_id: string; token_endpoint: string; label?: string },
): StoredGrant {
  return {
    client_id: base.client_id,
    token_endpoint: base.token_endpoint,
    access_token: tokens.accessToken,
    ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
    ...(tokens.expiresAt !== undefined
      ? { expires_at: new Date(tokens.expiresAt).toISOString() }
      : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    ...(base.label ? { label: base.label } : {}),
  };
}

function toFields(grant: StoredGrant): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(grant)) {
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

function fromFields(fields: Record<string, string> | null): StoredGrant | null {
  if (!fields?.client_id || !fields.token_endpoint || !fields.access_token) return null;
  return fields as unknown as StoredGrant;
}

export function hasGrant(accountId: string, configDir?: string): boolean {
  return hasProviderAccountCredentials(KONDO_FILE_KEY, accountId, configDir);
}

export async function readGrant(
  accountId: string,
  configDir?: string,
): Promise<StoredGrant | null> {
  return fromFields(await readProviderAccountCredentials(KONDO_FILE_KEY, accountId, configDir));
}

export async function writeGrant(
  accountId: string,
  grant: StoredGrant,
  configDir?: string,
): Promise<void> {
  await writeProviderAccountCredentials(KONDO_FILE_KEY, accountId, toFields(grant), configDir);
}

/**
 * The account's credential state, from the stored grant alone. A refresh that
 * fails because Kondo is unreachable never changes it; only a refused refresh
 * token does, by stamping `revoked_at`.
 */
export async function grantState(accountId: string, configDir?: string): Promise<ConnectionState> {
  if (!hasGrant(accountId, configDir)) return { status: "never-connected" };
  const grant = await readGrant(accountId, configDir);
  if (!grant) throw new Error("Unreadable Kondo credential");
  if (grant.revoked_at) {
    return { status: "revoked", at: grant.revoked_at, detail: "Kondo refused the refresh token" };
  }
  if (!grant.refresh_token && grant.expires_at && Date.parse(grant.expires_at) <= Date.now()) {
    return { status: "expired", at: grant.expires_at };
  }
  return { status: "connected" };
}

export const REAUTH_REMEDIATION: SyncRemediation = {
  summary: "Sign in to Kondo again",
  steps: [
    "Run `omnesis sources reauth kondo:<account>` on the collector, or choose Reconnect on the Sources page.",
  ],
  restartRequired: false,
};

function refreshFailure(err: unknown): SyncError {
  if (err instanceof OAuthError && err.reason === "refused") {
    return new SyncError("auth", `Kondo refused to renew the sign-in: ${err.message}`, {
      scope: "connection",
      remediation: REAUTH_REMEDIATION,
    });
  }
  if (err instanceof OAuthError && err.reason === "unavailable") {
    return new SyncError("network", `Kondo's sign-in could not be renewed: ${err.message}`, {
      cause: err,
    });
  }
  return new SyncError("unknown", `Kondo's sign-in could not be renewed: ${describe(err)}`, {
    cause: err,
  });
}

function needsRenewal(grant: StoredGrant, now: number): boolean {
  if (!grant.refresh_token || !grant.expires_at) return false;
  return Date.parse(grant.expires_at) - EXPIRY_MARGIN_MS <= now;
}

/**
 * The grant on disk. Read afresh on every request, so a sign-in completed in
 * the auth subprocess is picked up without a restart; renewals are shared by
 * every request waiting on one.
 */
export class StoredTokens implements TokenSource {
  private renewing: Promise<string> | undefined;

  constructor(
    private readonly accountId: string,
    private readonly configDir: string | undefined,
    private readonly deps: OAuthDeps = {},
  ) {}

  private async load(): Promise<StoredGrant> {
    const grant = await readGrant(this.accountId, this.configDir);
    if (!grant) {
      throw new SyncError("auth", "No Kondo sign-in is stored for this account.", {
        scope: "connection",
        remediation: REAUTH_REMEDIATION,
      });
    }
    if (grant.revoked_at) {
      throw new SyncError("auth", "Kondo refused to renew this account's sign-in.", {
        scope: "connection",
        remediation: REAUTH_REMEDIATION,
      });
    }
    return grant;
  }

  async accessToken(signal?: AbortSignal): Promise<string> {
    const grant = await this.load();
    const now = (this.deps.now ?? Date.now)();
    if (!needsRenewal(grant, now)) return grant.access_token;
    return this.refresh(grant.access_token, signal);
  }

  refresh(rejected: string, signal?: AbortSignal): Promise<string> {
    this.renewing ??= this.renew(rejected, signal).finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  private async renew(rejected: string, signal?: AbortSignal): Promise<string> {
    const grant = await this.load();
    const now = (this.deps.now ?? Date.now)();
    if (grant.access_token !== rejected && !needsRenewal(grant, now)) return grant.access_token;
    if (!grant.refresh_token) {
      throw new SyncError("auth", "Kondo's sign-in lapsed and holds no refresh token.", {
        scope: "connection",
        remediation: REAUTH_REMEDIATION,
      });
    }
    let tokens: TokenSet;
    try {
      tokens = await refreshGrant(
        grant.token_endpoint,
        { clientId: grant.client_id, refreshToken: grant.refresh_token },
        this.deps,
        signal,
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof OAuthError && err.reason === "refused") {
        await writeGrant(
          this.accountId,
          { ...grant, revoked_at: new Date(now).toISOString() },
          this.configDir,
        ).catch((writeErr: unknown) =>
          log.warn(`Could not record Kondo's refusal for ${this.accountId}: ${describe(writeErr)}`),
        );
      }
      throw refreshFailure(err);
    }
    const renewed = grantFromTokens(
      { ...tokens, refreshToken: tokens.refreshToken ?? grant.refresh_token },
      { client_id: grant.client_id, token_endpoint: grant.token_endpoint, label: grant.label },
    );
    try {
      await writeGrant(this.accountId, renewed, this.configDir);
    } catch (err) {
      throw new SyncError(
        "unknown",
        `Kondo renewed the sign-in but it could not be stored: ${describe(err)}`,
        { cause: err },
      );
    }
    log.info(`Renewed Kondo sign-in for ${this.accountId}`);
    return renewed.access_token;
  }
}

/** A grant held in memory during sign-in, before the account it belongs to is known. */
export class MemoryTokens implements TokenSource {
  constructor(
    public tokens: TokenSet,
    private readonly tokenEndpoint: string,
    private readonly clientId: string,
    private readonly deps: OAuthDeps = {},
  ) {}

  accessToken(): Promise<string> {
    return Promise.resolve(this.tokens.accessToken);
  }

  async refresh(_rejected: string, signal?: AbortSignal): Promise<string> {
    if (!this.tokens.refreshToken) {
      throw new SyncError("auth", "Kondo refused the new sign-in.", { scope: "connection" });
    }
    try {
      const renewed = await refreshGrant(
        this.tokenEndpoint,
        { clientId: this.clientId, refreshToken: this.tokens.refreshToken },
        this.deps,
        signal,
      );
      this.tokens = { ...renewed, refreshToken: renewed.refreshToken ?? this.tokens.refreshToken };
      return this.tokens.accessToken;
    } catch (err) {
      throw refreshFailure(err);
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
