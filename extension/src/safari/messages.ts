// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { MAX_CAPTURE_DOMAIN_CHARS } from "@omnesis/provider-web/capture-policy";

/** A page asking the background to adopt the app's current pairing. */
export const SAFARI_SYNC_MESSAGE_TYPE = "safari-sync";

export type SafariPopupMessage =
  | { type: "safari-status" }
  | { type: "safari-set-pause"; until: number | null }
  | { type: "safari-resume" }
  | { type: "safari-exclude"; domain: string }
  | { type: "safari-include"; domain: string };

export type SafariStatus =
  | { paired: false }
  | {
      paired: true;
      gatewayHost: string;
      /** False until the gateway's capture settings have been read once. */
      policyKnown: boolean;
      paused: boolean;
      /** Epoch-ms a timed pause ends; absent for an open-ended one. */
      pausedUntil?: number;
      excludedDomains: string[];
      queued: number;
      healthy: boolean;
      lastCapturedAt?: number;
    };

export type SafariPopupAck = { ok: true; status: SafariStatus } | { ok: false; reason: string };

function isDomain(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CAPTURE_DOMAIN_CHARS;
}

export function isSafariPopupMessage(message: unknown): message is SafariPopupMessage {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { type?: unknown; until?: unknown; domain?: unknown };
  switch (candidate.type) {
    case "safari-status":
    case "safari-resume":
      return true;
    case "safari-set-pause":
      return (
        candidate.until === null ||
        (typeof candidate.until === "number" &&
          Number.isInteger(candidate.until) &&
          candidate.until >= 0)
      );
    case "safari-exclude":
    case "safari-include":
      return isDomain(candidate.domain);
    default:
      return false;
  }
}
