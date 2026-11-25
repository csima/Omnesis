// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  clearProviderAccountCredentials,
  createLogger,
  CredentialPersistError,
  hasProviderAccountCredentials,
  listProviderAccountIds,
  MissingCredentialsError,
  readProviderAccountCredentials,
  writeProviderAccountCredentials,
} from "@omnesis/core";
import { AccountId, SyncError, tryAccountId } from "@omnesis/types";
import { AuthFailure, credentialsChallenge } from "@omnesis/source-sdk";
import { QuoClient } from "./client.js";
import { quoCredentialsSpec } from "./credentials-spec.js";
import type { AccountDescriptor, AuthResult, AuthSession } from "@omnesis/source-sdk";
import type { QuoClientOptions } from "./client.js";

const log = createLogger("provider:quo");

export const QUO_FILE_KEY = "quo";

/** One account's stored connection. */
export interface QuoConnection {
  apiKey: string;
  /** The workspace's name as Quo reported it when the key was checked. */
  organizationName?: string;
}

/** Load one account's stored key, or throw naming what is missing. */
export async function loadConnection(
  accountId: string,
  configDir?: string,
): Promise<QuoConnection> {
  const fields = await readProviderAccountCredentials(QUO_FILE_KEY, accountId, configDir);
  if (!fields?.api_key) throw new MissingCredentialsError(QUO_FILE_KEY, "Quo");
  return {
    apiKey: fields.api_key,
    organizationName: fields.organization_name || undefined,
  };
}

/** Whether this account's key is on disk. Offline — no network probe. */
export function hasCredentials(accountId: string, configDir?: string): boolean {
  return hasProviderAccountCredentials(QUO_FILE_KEY, accountId, configDir);
}

/**
 * Connect a Quo workspace.
 *
 * The account is the organization the key belongs to (`OR…`), which is what
 * the key reads: every number and every conversation in it. The key is asked
 * for rather than handed in, so a re-authentication can offer a new key after
 * the old one was deleted in Quo. Nothing is written until Quo accepts it.
 */
export async function authenticate(
  session: AuthSession,
  opts: QuoClientOptions = {},
): Promise<AuthResult> {
  const configDir = session.host.configDir;
  const reauthAccountId = session.accountId;

  const challenge = credentialsChallenge(quoCredentialsSpec, {
    title: reauthAccountId ? `Reconnect ${reauthAccountId}` : "Connect a Quo workspace",
    instructions:
      "In Quo open Workspace Settings, then API, generate a key and paste it here. Only " +
      "workspace owners and admins can create keys. Omnesis only reads with it.",
  });

  const suppliedKey = session.supplied.api_key?.trim();
  const answered = suppliedKey ? session.supplied : await session.ask(challenge);
  const apiKey = String(answered.api_key ?? "").trim();
  if (!apiKey) throw new MissingCredentialsError(QUO_FILE_KEY, "Quo");

  session.show({ kind: "wait", title: "Checking the API key" });

  let organization: { id: string; name?: string | null };
  try {
    organization = await new QuoClient(apiKey, opts).getOrganization();
  } catch (err) {
    throw probeFailure(err);
  }
  const accountId = tryAccountId(organization.id);
  if (!accountId) {
    throw new AuthFailure(
      "unsupported",
      `Quo named the workspace ${organization.id}, which Omnesis cannot use as an account.`,
    );
  }

  // A re-auth renews the workspace it was invoked for. A key from another
  // workspace would point this source at someone else's messages.
  const renewing = session.reason === "reauthenticate" ? reauthAccountId : undefined;
  if (renewing && String(accountId) !== renewing) {
    throw new AuthFailure(
      "identity-mismatch",
      `This API key belongs to the Quo workspace ${accountId}, not ${renewing}.`,
      { remedy: "Add it as a separate source instead of re-authenticating this one." },
    );
  }

  try {
    await writeProviderAccountCredentials(
      QUO_FILE_KEY,
      String(accountId),
      {
        api_key: apiKey,
        ...(organization.name ? { organization_name: organization.name } : {}),
      },
      configDir,
    );
  } catch (err) {
    throw new CredentialPersistError(QUO_FILE_KEY, String(accountId), err);
  }
  log.info(
    `Authenticated with Quo workspace ${organization.name ?? accountId} (account ${accountId})`,
  );
  return { accounts: [{ accountId: String(accountId), state: { status: "connected" } }] };
}

/**
 * What a failed probe means for the operator. A 401 is the key; a 403 is a
 * key Quo recognises but will not serve; an outage or a rate limit may clear
 * on its own.
 */
function probeFailure(err: unknown): AuthFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof SyncError) {
    if (err.kind === "auth") {
      return new AuthFailure("credential-rejected", message, {
        remedy:
          "Generate a new key in Quo under Workspace Settings, API, and paste that one. " +
          "Paste the key alone, without a Bearer prefix.",
      });
    }
    if (err.kind === "permission") {
      return new AuthFailure("credential-rejected", message, {
        remedy:
          "The key is valid, but Quo will not serve it. Check that the workspace's subscription " +
          "is active, then connect again.",
      });
    }
    if (err.kind === "network" || err.kind === "transient" || err.kind === "rate-limit") {
      return new AuthFailure("unavailable", message, {
        remedy: "Check that this collector can reach api.quo.com, then try again.",
      });
    }
  }
  return new AuthFailure("unknown", message);
}

/**
 * Configured accounts, offline: the provider-instantiation path derives its
 * instances from this alone, so it never touches the network.
 */
export function discoverAccounts(configDir?: string): AccountDescriptor[] {
  return listProviderAccountIds(QUO_FILE_KEY, configDir).map((id) => ({
    id: String(AccountId(id)),
    subject: { kind: "opaque" as const, value: id },
    tenant: { id },
  }));
}

/** Remove one account's stored key; sibling accounts keep theirs. */
export async function cleanupCredentials(accountId: string, configDir?: string): Promise<void> {
  await clearProviderAccountCredentials(QUO_FILE_KEY, accountId, configDir);
  log.info(`Cleaned up Quo credentials for account ${accountId}`);
}
