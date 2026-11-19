// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { config, defineProvider } from "@omnesis/source-sdk";
import { SyncError } from "@omnesis/types";
import { slackCredentialsSpec } from "./credentials-spec.js";
import { slackIcon } from "./icons.js";
import { profileFor } from "./profile.js";
import {
  authenticateOfficial,
  authenticateSession,
  cleanupOfficial,
  cleanupSession,
  discoverOfficial,
  discoverSession,
  loadOfficial,
  loadSessionManifest,
  authFailure,
} from "./provider.js";
import { bridge, credentialsFromBundle } from "./session.js";
import { SlackSource } from "./source.js";
import { slackStateSpec } from "./state.js";
import { schemasFor } from "./schemas.js";
import { accountKey } from "./types.js";
import type { ProviderSourceEntry } from "@omnesis/source-sdk";

interface Context {
  accountId: string;
  configDir: string;
}
const settings = config.object({
  historyDays: config.number({
    label: "Initial history in days",
    help: "Bounds only the first sync. Indexed history does not expire.",
    default: 180,
    min: 1,
    max: 3650,
    integer: true,
  }),
});
function entry(
  session: boolean,
): ProviderSourceEntry<Context> & { create: NonNullable<ProviderSourceEntry<Context>["create"]> } {
  return {
    id: session ? "slack-session" : "slack",
    name: session ? "Slack session (experimental)" : "Slack",
    description: session
      ? "Read signed-in Slack workspaces locally on a Mac through the reviewed helper"
      : "Slack channels, private channels, DMs and threads using an official user token",
    experimental: session,
    authType: session ? "local" : "api-key",
    credentials: session ? undefined : slackCredentialsSpec,
    authenticate: async (flow) => {
      try {
        return await (session ? authenticateSession : authenticateOfficial)(flow);
      } catch (err) {
        throw authFailure(err);
      }
    },
    cleanupCredentials: session ? cleanupSession : cleanupOfficial,
    discover: session ? discoverSession : discoverOfficial,
    supportedPlatforms: session ? ["darwin"] : undefined,
    selfIdentity: { aliasPrefix: "slack", accountPattern: "^T[A-Z0-9]{2,40}-[UW][A-Z0-9]{2,40}$" },
    unitName: "conversations",
    primaryCount: "documents",
    icon: slackIcon,
    defaultSyncInterval: "15m",
    config: settings,
    multiDevice: { mode: "exclusive" },
    contentRetention: "best-effort",
    contract: {
      apiVersion: 2,
      outputRevision: 1,
      state: slackStateSpec,
      requires: [
        "state-envelope",
        "scoped-host",
        "multi-table-batch",
        "tuple-deletes",
        "typed-config",
      ],
    },
    documentEventProfile: profileFor(session),
    analyticsSchemas: schemasFor(session),
    // A daily document is addressed by its first message, but inbound message URLs
    // need the UTC root day. No regex can infer that day from Slack's decimal epoch.
    // Deliberately no misleading urlPattern that resolves to a different externalId.
    async create(options, ctx) {
      if (!options.host) throw new Error("Slack requires a source-scoped host");
      const days = Number(options.config?.historyDays ?? 180);
      const source = new SlackSource({
        accountId: ctx.accountId,
        sourceId: options.sourceId,
        providerId: options.providerId,
        session,
        historyDays: days,
        dataCutoff: options.dataCutoff,
        host: options.host,
        async acquire(signal) {
          if (!session) return loadOfficial(ctx.accountId, ctx.configDir);
          const manifest = await loadSessionManifest(ctx.configDir, ctx.accountId);
          const found = credentialsFromBundle(await bridge(manifest.config, "collect", signal));
          const credential = found.credentials.find(
            (v) => accountKey(v.identity) === ctx.accountId,
          );
          if (!credential)
            throw new SyncError(
              "auth",
              "Slack workspace sign-in is unavailable; sign in again in Slack or Chrome. Indexed history is kept.",
              {
                remediation: {
                  summary: "Sign in again to this Slack workspace",
                  steps: [
                    "Open Slack or Chrome on the collector Mac and sign in. The next cycle retries automatically.",
                  ],
                  restartRequired: false,
                },
              },
            );
          return credential;
        },
      });
      const stored = await storedWorkspaceName(session, ctx.accountId, ctx.configDir);
      return {
        icon: slackIcon,
        get label() {
          return source.workspaceName ?? stored;
        },
        analyticsSchemas: schemasFor(session),
        sync: (cursor, opts) => source.sync(slackStateSpec.decode(cursor), opts),
        syncStructured: (cursor, opts) =>
          source.syncStructured(slackStateSpec.decode(cursor), opts),
        dispose: () => Promise.resolve(source.dispose()),
        credentialState: () =>
          Promise.resolve({
            status: "unknown" as const,
            because: "Credentials are checked at sync, not with a network admission probe",
          }),
      };
    },
  };
}
async function storedWorkspaceName(
  session: boolean,
  accountId: string,
  configDir: string,
): Promise<string | undefined> {
  try {
    const identity = session
      ? (await loadSessionManifest(configDir, accountId)).accounts.find(
          (a) => accountKey(a) === accountId,
        )
      : (await loadOfficial(accountId, configDir)).identity;
    return identity?.team.trim() || undefined;
  } catch {
    return undefined;
  }
}
export default defineProvider<Context>({
  provider: { id: "slack", name: "Slack" },
  authType: "api-key",
  async discover(ctx) {
    return [...new Set([...(await discoverOfficial(ctx)), ...(await discoverSession(ctx))])];
  },
  createContext({ accountId, host }) {
    if (!host) return Promise.reject(new Error("Slack requires an account-scoped host"));
    return Promise.resolve({ accountId: String(accountId), configDir: host.configDir });
  },
  sources: [entry(false), entry(true)],
});

export { normalizeDay } from "./normalizer.js";
export { conversationSchema, messageSchema, userSchema } from "./types.js";
