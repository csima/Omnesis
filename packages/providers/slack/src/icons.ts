// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import type { SourceIcon } from "@omnesis/source-sdk";
/** Provider-owned generic chat glyph; deliberately not Slack's trademarked mark. */
export const slackIcon: SourceIcon = {
  sfSymbol: "bubble.left.and.bubble.right.fill",
  color: "#4A154B",
  bgColor: "#F5EDF5",
  imageDataUri:
    "data:image/svg+xml;base64," +
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#4A154B" d="M3 3h18v14H9l-6 4z"/><path fill="#fff" d="M6 7h12v2H6zm0 4h8v2H6z"/></svg>',
    ).toString("base64"),
};
