// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { mkdir, readFile, writeFile, rm, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  createLogger,
  loadOrAdoptProviderAccountCredentials,
  writeProviderAccountCredentials,
  listProviderAccountIds,
  clearProviderAccountCredentials,
} from "@omnesis/core";
import { AuthFailure, credentialsChallenge } from "@omnesis/source-sdk";
import { SyncError } from "@omnesis/types";
import { SlackClient } from "./client.js";
import { slackCredentialsSpec } from "./credentials-spec.js";
import { bridge, credentialsFromBundle } from "./session.js";
import { accountKey, workspaceUrl, idSchema } from "./types.js";
import type { AuthResult, AuthSession, SourceLifecycleContext } from "@omnesis/source-sdk";
import type { Credential, Identity } from "./types.js";
import type { SessionConfig } from "./session.js";

const log = createLogger("provider:slack");
const identitySchema = z.object({
  team_id: idSchema,
  user_id: idSchema,
  team: z.string(),
  url: z.string(),
});
export async function verifyOfficial(token: string, signal?: AbortSignal): Promise<Credential> {
  if (!/^xoxp-[^\s]+$/.test(token))
    throw new AuthFailure(
      "credential-rejected",
      "Use a Slack user OAuth token with read-only scopes",
    );
  const provisional: Credential = {
    token,
    identity: { team_id: "T00", user_id: "U00", team: "Slack", url: "https://example.slack.com/" },
  };
  let auth: Record<string, unknown>;
  try {
    auth = await new SlackClient(provisional).call("auth.test", {}, signal);
  } catch (err) {
    throw authFailure(err);
  }
  const r = identitySchema.safeParse(auth);
  if (!r.success)
    throw new AuthFailure(
      "credential-rejected",
      "Slack did not return a workspace and user identity",
    );
  let url: string;
  try {
    url = workspaceUrl(r.data.url);
  } catch {
    throw new AuthFailure(
      "unsupported",
      "This Slack workspace host is not supported; use a workspace on slack.com or enterprise.slack.com",
    );
  }
  return { token, identity: { ...r.data, url } };
}
export async function authenticateOfficial(session: AuthSession): Promise<AuthResult> {
  const answer = session.supplied.token
    ? session.supplied
    : await session.ask(
        credentialsChallenge(slackCredentialsSpec, {
          title: "Connect Slack",
          instructions: "Paste the read-only User OAuth Token from your installed Slack app.",
        }),
      );
  const credential = await verifyOfficial(String(answer.token ?? ""));
  const key = accountKey(credential.identity);
  if (session.accountId && key !== session.accountId)
    throw new AuthFailure(
      "identity-mismatch",
      "This token belongs to another workspace/user; add it separately",
    );
  // Official tokens use the standard wrapped provider credential store.
  await writeProviderAccountCredentials(
    "slack",
    key,
    { token: credential.token, identity: JSON.stringify(credential.identity) },
    session.host.configDir,
  );
  log.info(`Connected official Slack account ${key}`);
  return { accounts: [{ accountId: key, state: { status: "connected" } }] };
}
export async function loadOfficial(key: string, configDir: string): Promise<Credential> {
  const fields = await loadOrAdoptProviderAccountCredentials("slack", key, configDir);
  if (!fields?.token || !fields.identity)
    throw new AuthFailure("missing-credentials", "Reconnect the Slack user token");
  const identity = identitySchema.parse(JSON.parse(fields.identity));
  if (accountKey(identity) !== key)
    throw new AuthFailure("identity-mismatch", "Stored Slack account identity differs");
  return { token: fields.token, identity };
}
export function discoverOfficial(ctx?: SourceLifecycleContext) {
  return Promise.resolve(listProviderAccountIds("slack", ctx?.configDir));
}
export async function cleanupOfficial(key: string, ctx?: SourceLifecycleContext): Promise<void> {
  await clearProviderAccountCredentials("slack", key, ctx?.configDir);
}

// Session settings and account descriptors are public metadata only. Credentials never reach this file.
const settingsSchema = z.object({
  root: z.string(),
  python: z.string(),
  sources: z.array(z.string()),
  userAgents: z.object({ slack: z.string().optional(), chrome: z.string().optional() }),
});
const sessionManifestSchema = z.object({
  config: settingsSchema,
  accounts: z.array(identitySchema),
});
const manifestPath = (configDir: string, key: string): string => {
  if (!/^T[A-Z0-9]{2,40}-[UW][A-Z0-9]{2,40}$/.test(key))
    throw new AuthFailure("identity-mismatch", "Invalid Slack account key");
  return join(configDir, "slack-session", key, "connection.json");
};
export async function loadSessionManifest(configDir: string, key: string) {
  try {
    return sessionManifestSchema.parse(
      JSON.parse(await readFile(manifestPath(configDir, key), "utf8")),
    );
  } catch {
    throw new AuthFailure(
      "missing-credentials",
      "Connect Slack session on the collector Mac and select the reviewed helper",
    );
  }
}
export async function authenticateSession(session: AuthSession): Promise<AuthResult> {
  if (process.platform !== "darwin")
    throw new AuthFailure(
      "unsupported",
      "Connect Slack session on the Mac signed into Slack or Chrome",
    );
  const { config } = await import("@omnesis/source-sdk");
  const fields = config.object({
    root: config.path({
      label: "Reviewed slack-grab root",
      required: true,
      mustExist: "directory",
      mustContain: "slacklib/grab.py",
      mustContainKind: "file",
      containsHint: "Select the installed reviewed helper root.",
    }),
    python: config.path({ label: "Helper Python", required: true, mustExist: "file" }),
    slackUserAgent: config.string({
      label: "Desktop User-Agent",
      help: "Leave blank when stored unambiguously by Slack.",
    }),
    chromeUserAgent: config.string({
      label: "Chrome User-Agent",
      help: "Leave blank when stored unambiguously by Chrome.",
    }),
  });
  const answer = await session.ask({
    kind: "fields",
    title: "Choose the local Slack helper",
    instructions:
      "Only the reviewed helper reads app and Chrome stores. You answer any macOS Keychain prompts yourself. Missing User-Agents must be supplied exactly, never guessed.",
    schema: fields,
  });
  const initial: SessionConfig = {
    root: String(answer.root),
    python: String(answer.python),
    sources: [],
    userAgents: {
      slack: String(answer.slackUserAgent ?? "") || undefined,
      chrome: String(answer.chromeUserAgent ?? "") || undefined,
    },
  };
  const listing = z.object({ sources: z.array(z.string()) }).parse(await bridge(initial, "list"));
  session.show({
    kind: "wait",
    title: "Slack sign-in sources found",
    instructions: listing.sources.join("\n") || "No supported sign-in sources found.",
  });
  const selected = await session.ask({
    kind: "fields",
    title: "Select sign-in sources",
    instructions:
      "Leave blank to use every discovered source. Enter source IDs separated by commas to narrow the selection.",
    schema: config.object({
      sources: config.string({
        label: "Sign-in source IDs",
        help: "Blank means all discovered sources.",
      }),
    }),
  });
  initial.sources = String(selected.sources ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (initial.sources.some((s) => !listing.sources.includes(s)))
    throw new AuthFailure("credential-rejected", "Choose only IDs listed by the helper");
  const found = credentialsFromBundle(await bridge(initial, "collect"));
  const accounts: Identity[] = [];
  let lastFailure: unknown;
  for (const credential of found.credentials) {
    let auth: Record<string, unknown>;
    try {
      auth = await new SlackClient(credential).call("auth.test");
    } catch (err) {
      lastFailure = err;
      found.failures.push(accountKey(credential.identity));
      continue;
    }
    if (
      auth.team_id !== credential.identity.team_id ||
      auth.user_id !== credential.identity.user_id
    )
      continue;
    if (!session.accountId || accountKey(credential.identity) === session.accountId)
      accounts.push(credential.identity);
  }
  if (!accounts.length && lastFailure) throw authFailure(lastFailure);
  if (!accounts.length)
    throw new AuthFailure(
      "credential-rejected",
      "No matching workspace/user sign-in passed; sign in again and check helper permissions and exact User-Agents",
    );
  for (const identity of accounts) {
    const key = accountKey(identity);
    const path = manifestPath(session.host.configDir, key);
    await mkdir(join(session.host.configDir, "slack-session", key), {
      recursive: true,
      mode: 0o700,
    });
    const temp = path + "." + session.flowId + ".tmp";
    await writeFile(temp, JSON.stringify({ config: initial, accounts: [identity] }), {
      mode: 0o600,
    });
    await rename(temp, path);
  }
  return {
    accounts: accounts.map((a) => ({ accountId: accountKey(a), state: { status: "connected" } })),
    notices: found.failures.map((s) => ({
      title: `Sign-in source unavailable: ${s}`,
      detail:
        "Its accounts were not erased. Sign in or allow the normal Keychain prompt; the next cycle retries.",
    })),
  };
}
export async function discoverSession(ctx?: SourceLifecycleContext): Promise<string[]> {
  if (!ctx?.configDir) return [];
  try {
    const names = await readdir(join(ctx.configDir, "slack-session"));
    const ids: string[] = [];
    for (const name of names) {
      try {
        await loadSessionManifest(ctx.configDir, name);
        ids.push(name);
      } catch {
        /* Not a complete configured account. */
      }
    }
    return ids;
  } catch {
    return [];
  }
}
export async function cleanupSession(key: string, ctx?: SourceLifecycleContext): Promise<void> {
  if (ctx?.configDir) await rm(manifestPath(ctx.configDir, key), { force: true });
}
export function authFailure(err: unknown): AuthFailure {
  if (err instanceof AuthFailure) return err;
  if (err instanceof SyncError)
    return new AuthFailure(
      err.kind === "auth"
        ? "credential-rejected"
        : err.kind === "permission"
          ? "credential-rejected"
          : "unavailable",
      err.message,
    );
  return new AuthFailure(
    "unavailable",
    "Slack connection could not complete; retry on the collector host",
  );
}
