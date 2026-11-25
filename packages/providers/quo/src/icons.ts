// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * The Quo mark, used nominatively to identify the source; see TRADEMARKS.md.
 * Bundled from the favicon of Quo's own API documentation rather than
 * hot-linked, because the marketing site serves its app icon from hashed CDN
 * paths that change without notice.
 *
 * The SF Symbol is iOS's instant-render fallback: a speech bubble reads as
 * text messages at a glance. Colours are the mark's own yellow and ink.
 */
export const quoIcon: SourceIcon = {
  sfSymbol: "message.fill",
  color: "#0A0A0C",
  bgColor: "#EDFC47",
  imageDataUri:
    "data:image/svg+xml;base64," +
    Buffer.from(
      '<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="1024" height="1024" rx="288" fill="#EDFC47"/><path fill-rule="evenodd" clip-rule="evenodd" d="M243 338C309.166 338 362 390.968 362 458V566C362 608.719 340.54 645.724 307.849 666.949L308 667C325.954 673.119 346.609 678 378 678H384L364 742H356C294.308 742 271.642 716 209 716H201L211.716 681.901C160.937 668.258 124 622.045 124 566V458C124 390.968 176.838 338 243 338ZM243 403C212.538 403 189 426.574 189 457V567C189 597.426 212.538 621 243 621C273.467 621 297 597.426 297 567V457C297 426.574 273.467 403 243 403Z" fill="#0A0A0C"/><path d="M458 567C458 597.39 481.533 621 512 621C542.462 621 566 597.39 566 567V346H631V566C631 632.954 578.162 686 512 686C445.834 686 393 632.954 393 566V346H458V567Z" fill="#0A0A0C"/><path fill-rule="evenodd" clip-rule="evenodd" d="M781 338C847.166 338 900 390.968 900 458V566C900 633.032 847.166 686 781 686C714.838 686 662 633.032 662 566V458C662 390.968 714.838 338 781 338ZM781 403C750.538 403 727 426.574 727 457V567C727 597.426 750.538 621 781 621C811.467 621 835 597.426 835 567V457C835 426.574 811.467 403 781 403Z" fill="#0A0A0C"/></svg>',
    ).toString("base64"),
};
