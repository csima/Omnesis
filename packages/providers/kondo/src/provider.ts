// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

/**
 * Connecting a Kondo account.
 *
 * Sign-in is OAuth with PKCE against Kondo's own authorization server, through
 * a client registered dynamically for exactly the redirect this attempt uses:
 * the gateway's callback when the host has a public origin, otherwise a
 * listener on an ephemeral loopback port of the collector. A fresh port per
 * attempt is why the client is registered per attempt — the redirect must match
 * the registration — and it means two sign-ins at once never collide.
 *
 * The grant is kept in memory until the account it belongs to is known, which
 * takes a connected Kondo tab: only then does Kondo say which LinkedIn member
 * owns the inbox. Nothing is written for an attempt that does not get that far.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  clearProviderAccountCredentials,
  createLogger,
  CredentialPersistError,
  listProviderAccountIds,
  oauthCallbackHost,
} from "@omnesis/core";
import { AuthFailure } from "@omnesis/source-sdk";
import { SyncError } from "@omnesis/types";
import { KondoClient } from "./client.js";
import { grantFromTokens, KONDO_FILE_KEY, MemoryTokens, writeGrant } from "./credentials.js";
import {
  buildAuthorizeUrl,
  createPkce,
  discoverAuthServer,
  exchangeCode,
  OAuthError,
  registerClient,
  tokenSubject,
} from "./oauth.js";
import { WALKED_INBOXES } from "./types.js";
import type { AuthResult, AuthSession } from "@omnesis/source-sdk";
import type { KondoClientOptions } from "./client.js";
import type { AuthServerMetadata, TokenSet } from "./oauth.js";

const log = createLogger("provider:kondo");

const CALLBACK_PATH = "/callback";

/** An account id built from the Kondo user when the inbox has no chat to name its owner. */
const USER_ACCOUNT_PREFIX = "user-";

export interface AuthenticateDeps {
  fetchImpl?: typeof fetch;
  client?: Omit<KondoClientOptions, "fetchImpl">;
  /** How long to wait for a Kondo tab after the browser sign-in. */
  tabWaitMs?: number;
  tabPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const TITLE = "Sign in to Kondo";
const INSTRUCTIONS =
  "Sign in with the account your Kondo inbox uses and allow Omnesis to read it. " +
  "Keep Kondo open in one Chrome tab: Kondo answers only while it is.";

export function authenticate(session: AuthSession): Promise<AuthResult> {
  return authenticateWith(session, {});
}

export async function authenticateWith(
  session: AuthSession,
  deps: AuthenticateDeps,
): Promise<AuthResult> {
  const oauthDeps = { fetchImpl: deps.fetchImpl };
  const meta = await withAuthFailure(() => discoverAuthServer(oauthDeps));
  const pkce = createPkce();

  let code: string;
  let redirectUri: string;
  let clientId: string;
  if (session.publicBaseUrl) {
    if (!session.flowId) {
      throw new AuthFailure("unknown", "This sign-in attempt has no id to match the redirect to.", {
        remedy: "Start the sign-in again.",
      });
    }
    redirectUri = `${session.publicBaseUrl.replace(/\/+$/, "")}/oauth/callback`;
    clientId = await withAuthFailure(() => registerClient(meta, redirectUri, oauthDeps));
    const answer = await session.ask({
      kind: "redirect",
      via: "gateway",
      title: TITLE,
      instructions: INSTRUCTIONS,
      url: buildAuthorizeUrl(meta, {
        clientId,
        redirectUri,
        state: session.flowId,
        challenge: pkce.challenge,
      }),
    });
    assertMatchingState(answer.state, session.flowId);
    code = answer.code;
  } else {
    const state = randomUUID();
    const listener = await bindCallbackListener(state);
    try {
      redirectUri = `http://127.0.0.1:${listener.port}${CALLBACK_PATH}`;
      clientId = await withAuthFailure(() => registerClient(meta, redirectUri, oauthDeps));
      const delivered = session.ask({
        kind: "redirect",
        via: "loopback",
        title: TITLE,
        instructions: INSTRUCTIONS,
        url: buildAuthorizeUrl(meta, {
          clientId,
          redirectUri,
          state,
          challenge: pkce.challenge,
        }),
      });
      void delivered.catch(() => {});
      void listener.result.catch(() => {});
      const answer: { code: string; state?: string } = await Promise.race([
        listener.result,
        delivered,
      ]);
      assertMatchingState(answer.state, state);
      code = answer.code;
    } finally {
      listener.close();
    }
  }

  session.show({ kind: "wait", title: "Finishing the Kondo sign-in" });
  const tokens = await exchange(
    meta,
    { clientId, code, redirectUri, verifier: pkce.verifier },
    oauthDeps,
  );
  const memory = new MemoryTokens(tokens, meta.token_endpoint, clientId, oauthDeps);
  const client = new KondoClient(memory, { ...deps.client, fetchImpl: deps.fetchImpl });
  const { accountId, label } = await resolveAccount(client, memory.tokens, session, deps);

  if (session.accountId && accountId !== session.accountId) {
    throw new AuthFailure(
      "identity-mismatch",
      `This Kondo sign-in reads the inbox of LinkedIn member ${accountId}, not ${session.accountId}.`,
      {
        remedy:
          "Sign in to the Kondo account that holds the original LinkedIn inbox, or add this one as a separate source.",
      },
    );
  }

  try {
    await writeGrant(
      accountId,
      grantFromTokens(memory.tokens, {
        client_id: clientId,
        token_endpoint: meta.token_endpoint,
        label,
      }),
      session.host.configDir,
    );
  } catch (err) {
    throw new CredentialPersistError(KONDO_FILE_KEY, accountId, err);
  }
  log.info(`Connected Kondo inbox ${label ?? accountId} (account ${accountId})`);
  return { accounts: [{ accountId, state: { status: "connected" } }] };
}

/**
 * Which LinkedIn member owns the inbox. Waits for a Kondo tab, since without
 * one Kondo lists nothing; an inbox with no chat at all falls back to the
 * Kondo user, which is the most stable identity left.
 */
async function resolveAccount(
  client: KondoClient,
  tokens: TokenSet,
  session: AuthSession,
  deps: AuthenticateDeps,
): Promise<{ accountId: string; label?: string }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (deps.tabWaitMs ?? 180_000);
  let shown = false;
  for (;;) {
    const status = await withAuthFailure(() => client.readStatus());
    if (status.connected) {
      for (const inbox of WALKED_INBOXES) {
        const page = await withAuthFailure(() => client.listInbox({ inbox, limit: 1 }));
        const owner = page.rows[0]?.profileUrn;
        if (owner) return { accountId: owner, label: status.linkedin ?? undefined };
      }
      const sub = tokenSubject(tokens.accessToken);
      if (!sub) {
        throw new AuthFailure(
          "unknown",
          "Kondo's inbox is empty and the sign-in names no user, so there is no account to add.",
          { remedy: "Start a conversation in Kondo, then sign in again." },
        );
      }
      return {
        accountId: `${USER_ACCOUNT_PREFIX}${sub.replace(/[^A-Za-z0-9_-]/g, "")}`,
        label: status.linkedin ?? undefined,
      };
    }
    if (Date.now() >= deadline) {
      throw new AuthFailure("unavailable", "Kondo is not open in a browser tab.", {
        remedy: "Open app.trykondo.com in one Chrome tab, then sign in again.",
      });
    }
    if (!shown) {
      session.show({
        kind: "wait",
        title: "Open Kondo in one Chrome tab",
        instructions:
          "Kondo answers only while it is open in a Chrome tab with its extension. Open app.trykondo.com; the sign-in continues on its own.",
      });
      shown = true;
    }
    await sleep(deps.tabPollMs ?? 3_000);
  }
}

async function exchange(
  meta: AuthServerMetadata,
  params: { clientId: string; code: string; redirectUri: string; verifier: string },
  oauthDeps: { fetchImpl?: typeof fetch },
): Promise<TokenSet> {
  try {
    return await exchangeCode(meta.token_endpoint, params, oauthDeps);
  } catch (err) {
    if (err instanceof OAuthError && err.reason === "refused") {
      throw new AuthFailure(
        "challenge-expired",
        `Kondo refused the authorization code: ${err.message}`,
        {
          remedy: "Start the sign-in again; an authorization code works once and expires quickly.",
        },
      );
    }
    throw toAuthFailure(err);
  }
}

async function withAuthFailure<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw toAuthFailure(err);
  }
}

function toAuthFailure(err: unknown): AuthFailure {
  if (err instanceof AuthFailure) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof OAuthError) {
    return err.reason === "unavailable"
      ? new AuthFailure("unavailable", message, { remedy: "Try again in a few minutes." })
      : new AuthFailure("unknown", message);
  }
  if (err instanceof SyncError) {
    if (err.kind === "auth" || err.kind === "permission") {
      return new AuthFailure("credential-rejected", message, {
        remedy: "Sign in again and allow Omnesis to read the inbox.",
      });
    }
    if (err.remediation) {
      return new AuthFailure("unavailable", message, { remedy: err.remediation.steps[0] });
    }
    if (err.kind === "network" || err.kind === "transient" || err.kind === "rate-limit") {
      return new AuthFailure("unavailable", message, { retryAfterMs: err.retryAfterMs });
    }
  }
  return new AuthFailure("unknown", message);
}

function assertMatchingState(answered: string | undefined, expected: string): void {
  if (answered === undefined || answered === expected) return;
  throw new AuthFailure(
    "unknown",
    "The Kondo authorization that came back belongs to a different sign-in attempt.",
    { remedy: "Close any other Kondo sign-in you have open, then start this one again." },
  );
}

interface CallbackListener {
  readonly port: number;
  readonly result: Promise<{ code: string; state?: string }>;
  close(): void;
}

/**
 * Bind the loopback listener on a port the OS picks, and resolve once it is
 * listening so the redirect is registered for a port that answers.
 */
export function bindCallbackListener(expectedState: string): Promise<CallbackListener> {
  return new Promise<CallbackListener>((bound, bindFailed) => {
    let settle: ((value: { code: string; state?: string }) => void) | undefined;
    let fail: ((err: Error) => void) | undefined;
    const result = new Promise<{ code: string; state?: string }>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    void result.catch(() => {});

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found.");
        return;
      }
      if (url.searchParams.get("state") !== expectedState) {
        log.warn("Ignored a Kondo sign-in callback with a different state");
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("This sign-in belongs to a different attempt. You can close this tab.");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h2>Kondo sign-in failed</h2><p>You can close this tab.</p></body></html>",
        );
        fail?.(
          error === "access_denied"
            ? new AuthFailure("denied", "The Kondo sign-in was declined.", {
                remedy: "Start the sign-in again and allow Omnesis to read the inbox.",
              })
            : new AuthFailure("unknown", `Kondo reported a sign-in error: ${error.slice(0, 80)}`),
        );
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Waiting for the Kondo sign-in.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h2>Kondo is connected</h2><p>You can close this tab.</p></body></html>",
      );
      settle?.({ code, state: expectedState });
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      const failure = new AuthFailure(
        "local-conflict",
        `The Kondo sign-in listener could not start: ${err.message}`,
        { remedy: "Check that this machine allows listening on a loopback port, then try again." },
      );
      bindFailed(failure);
      fail?.(failure);
    });

    server.listen(0, oauthCallbackHost("127.0.0.1"), () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      bound({
        port,
        result,
        close: () => {
          setTimeout(() => server.close(), 100).unref?.();
        },
      });
    });
  });
}

/** Accounts with a stored grant. Offline. */
export function discoverAccounts(configDir?: string): string[] {
  return listProviderAccountIds(KONDO_FILE_KEY, configDir);
}

export async function cleanupCredentials(accountId: string, configDir?: string): Promise<void> {
  await clearProviderAccountCredentials(KONDO_FILE_KEY, accountId, configDir);
  log.info(`Removed the Kondo sign-in for account ${accountId}`);
}

/** Whether an account id names a LinkedIn member, rather than the Kondo-user fallback. */
export function isMemberAccount(accountId: string): boolean {
  return !accountId.startsWith(USER_ACCOUNT_PREFIX);
}
