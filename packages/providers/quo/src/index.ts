// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The experimental Quo source: a Quo (formerly OpenPhone) workspace's text
 * messages, read through Quo's public API with a workspace API key — every
 * number, both directions, one document per message.
 */

import { readProviderAccountCredentials } from "@omnesis/core";
import { config, defineProvider, readConnectionState } from "@omnesis/source-sdk";
import { QuoClient } from "./client.js";
import { quoCredentialsSpec } from "./credentials-spec.js";
import { quoIcon } from "./icons.js";
import { QUO_MESSAGE_URL_PATTERN } from "./normalizer.js";
import { quoDocumentProfile } from "./profile.js";
import {
  authenticate,
  cleanupCredentials,
  discoverAccounts,
  hasCredentials,
  loadConnection,
  QUO_FILE_KEY,
} from "./provider.js";
import { QuoMessagesSource } from "./source.js";
import { quoMessagesStateSpec } from "./state.js";

export { QuoClient } from "./client.js";
export { quoCredentialsSpec } from "./credentials-spec.js";
export { normalizeMessage, quoLid, quoMessageUrl } from "./normalizer.js";
export { QuoMessagesSource } from "./source.js";
export { quoMessagesStateSpec } from "./state.js";
export type { QuoCursor } from "./state.js";
export type { QuoMessage } from "./schemas.js";

interface QuoContext {
  client: QuoClient;
  accountId: string;
  organizationName?: string;
  configDir?: string;
}

const settings = config.object({
  historyDays: config.number({
    label: "Initial history in days",
    help: "Bounds only the first sync. Indexed messages do not expire.",
    default: 180,
    min: 1,
    max: 3650,
    integer: true,
  }),
});

export default defineProvider<QuoContext>({
  provider: { id: "quo", name: "Quo" },
  authType: "api-key",
  credentials: quoCredentialsSpec,

  // Offline, from the stored keys: the collector derives its instances from
  // discover() alone. The account is the Quo organization the key reads.
  discover(ctx) {
    return Promise.resolve(discoverAccounts(ctx?.configDir));
  },

  authenticate(session) {
    return authenticate(session);
  },

  async cleanupCredentials(accountId: string, ctx) {
    await cleanupCredentials(accountId, ctx?.configDir);
  },

  async createContext({ accountId, host }) {
    const { apiKey, organizationName } = await loadConnection(String(accountId), host?.configDir);
    return {
      client: new QuoClient(apiKey),
      accountId: String(accountId),
      organizationName,
      configDir: host?.configDir,
    };
  },

  credentialState(ctx) {
    // Offline: Quo keys do not expire, so a stored key means connected. A
    // probe here could only add false negatives — an outage or a rate limit
    // would park the source in needs-auth — and a deleted key surfaces as an
    // `auth` failure on the next sync either way.
    return readConnectionState(async () => {
      if (!hasCredentials(String(ctx.accountId), ctx.configDir)) {
        return { status: "never-connected" };
      }
      const fields = await readProviderAccountCredentials(
        QUO_FILE_KEY,
        String(ctx.accountId),
        ctx.configDir,
      );
      if (!fields?.api_key) throw new Error("Unreadable Quo credential");
      return { status: "connected" };
    });
  },

  async disposeContext() {
    // Stateless HTTP client — nothing to clean up.
  },

  sources: [
    {
      id: "quo-messages",
      name: "Quo",
      description:
        "Text messages from a Quo (formerly OpenPhone) workspace — every number, sent and received, one searchable document per message",
      unitName: "texts",
      icon: quoIcon,
      // Not yet run against enough real workspaces to trust by default.
      experimental: true,
      config: settings,
      multiDevice: { mode: "exclusive" },
      defaultSyncInterval: "5m",
      // The account id is the organization; its LID is the self identity
      // outgoing messages carry, so the workspace's side resolves to you.
      selfIdentity: { aliasPrefix: "quo", accountPattern: "^OR[A-Za-z0-9]+$" },
      documentEventProfile: quoDocumentProfile,
      urlPatterns: [{ regex: QUO_MESSAGE_URL_PATTERN, idGroup: 1 }],
      contract: {
        apiVersion: 2,
        outputRevision: 1,
        state: quoMessagesStateSpec,
        requires: ["state-envelope", "scoped-host", "typed-config"],
      },
      create(options, ctx) {
        if (!options.host) {
          return Promise.reject(new Error("Quo requires a source-scoped host"));
        }
        const source = new QuoMessagesSource({
          client: ctx.client,
          providerId: options.providerId,
          sourceId: options.sourceId,
          organizationId: ctx.accountId,
          host: options.host,
          historyDays: Number(options.config?.historyDays ?? 180),
          dataCutoff: options.dataCutoff,
        });
        return Promise.resolve({
          icon: quoIcon,
          ...(ctx.organizationName ? { label: ctx.organizationName } : {}),
          sync: (cursor, opts) => source.sync(quoMessagesStateSpec.decode(cursor), opts),
        });
      },
    },
  ],
});
