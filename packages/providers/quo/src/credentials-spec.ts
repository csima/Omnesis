// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ProviderCredentialsSpec } from "@omnesis/core";

/**
 * Quo API-key credentials.
 *
 * A Quo key belongs to one workspace (organization) and reads everything in
 * it, so the key is this account's own credential rather than an application
 * credential shared across accounts: the wizard runs on every add and the
 * key is stored under the organization `authenticate()` resolves, only after
 * Quo accepted it.
 */
export const quoCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "quo",
  required: true,
  perAccount: true,
  fields: [
    {
      name: "api_key",
      label: "Quo API key",
      secret: true,
      // Keys are opaque; anything past "no whitespace" could refuse a key
      // Quo considers valid.
      pattern: "^\\S+$",
      patternHint: "Paste the key exactly as Quo shows it",
    },
  ],
  wizard: {
    intro:
      "Quo needs an API key to read your workspace's text messages. " +
      "A workspace owner or admin creates one in the Quo app.",
    why:
      "Omnesis reads messages through Quo's public API. The key stays on this collector and " +
      "Omnesis only reads with it, but Quo gives every key full access to the workspace's API, " +
      "so create one just for Omnesis and delete it in Quo to revoke access.",
    estMinutes: 2,
    steps: [
      {
        kind: "instruction",
        title: "Open API settings in Quo",
        body:
          "In Quo, open **Workspace Settings → API**. Only workspace owners and admins see " +
          "this tab.",
      },
      {
        kind: "instruction",
        title: "Generate and copy a key",
        body:
          "Click **Generate API key**, name it after Omnesis (for example `omnesis`), and copy " +
          "it. Paste it on the next screen.",
      },
    ],
  },
};
