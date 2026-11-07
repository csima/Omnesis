// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import type { ProviderCredentialsSpec } from "@omnesis/core";
export const slackCredentialsSpec: ProviderCredentialsSpec = {
  fileKey: "slack",
  required: true,
  perAccount: true,
  fields: [
    {
      name: "token",
      label: "Slack user OAuth token",
      secret: true,
      pattern: "^xoxp-[^\\s]+$",
      patternHint: "Use the user token from your installed Slack app.",
    },
  ],
  wizard: {
    intro: "Create a Slack app for your workspace and install it with read-only user scopes.",
    why: "Omnesis reads only conversations you belong to. Workspace policies and Slack retention limits still apply.",
    estMinutes: 5,
    steps: [
      {
        kind: "open-url",
        title: "Create a Slack app",
        body: "Create an app from scratch, choose your workspace, and open OAuth & Permissions.",
        url: "https://api.slack.com/apps",
      },
      {
        kind: "instruction",
        title: "Add user read scopes",
        body: "Add channels:read, channels:history, groups:read, groups:history, im:read, im:history, mpim:read, mpim:history, users:read, users:read.email, and usergroups:read. Install the app and copy the User OAuth Token. Do not add write scopes.",
      },
    ],
  },
};
