// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * A generic inbox glyph drawn for Omnesis — two overlapping speech bubbles —
 * rather than Kondo's or LinkedIn's mark, so no brand asset is bundled or
 * hot-linked. See `TRADEMARKS.md`.
 */
export const kondoIcon: SourceIcon = {
  sfSymbol: "bubble.left.and.bubble.right.fill",
  color: "#2D6CDF",
  bgColor: "#E8F0FD",
  imageDataUri:
    "data:image/svg+xml;base64," +
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2D6CDF"/><path fill="#FFFFFF" d="M14 16h26a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6H26l-8 7v-7h-4a6 6 0 0 1-6-6V22a6 6 0 0 1 6-6z"/><path fill="#BFD4F8" d="M49 26h1a6 6 0 0 1 6 6v10a6 6 0 0 1-6 6h-2v6l-7-6h-9a6 6 0 0 1-5-3h13a9 9 0 0 0 9-9z"/></svg>',
    ).toString("base64"),
};
