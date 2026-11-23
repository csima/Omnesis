// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway requests the Safari extension may ask the iPhone app to make:
 * the page uploads (the page, its visit and its screenshot) and the capture
 * settings it shows and edits. The app enforces the same list
 * (`SafariBridgeRequest` in the iOS sources), and
 * `ios/Tests/OmnesisTests/Fixtures/safari-bridge-requests.json` holds the
 * cases both sides are tested against. An app that does not yet allow the
 * screenshot upload refuses it, and the shot leaves the queue unsent while
 * pages keep flowing.
 */
const FIXED_REQUESTS: ReadonlySet<string> = new Set([
  "POST /documents",
  "POST /analytics/ingest",
  "PUT /documents/preview",
  "GET /web-capture-policy",
  "PUT /web-capture-policy/pause",
  "DELETE /web-capture-policy/pause",
  "POST /web-capture-policy/excluded-domains",
]);

const EXCLUDED_DOMAIN_PREFIX = "/web-capture-policy/excluded-domains/";

/** One path segment holding a lower-case host name, as the policy client encodes it. */
const DOMAIN_SEGMENT = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const MAX_DOMAIN_SEGMENT_CHARS = 253;

export function isAllowedNativeRequest(method: string, path: string): boolean {
  if (FIXED_REQUESTS.has(`${method} ${path}`)) return true;
  if (method !== "DELETE" || !path.startsWith(EXCLUDED_DOMAIN_PREFIX)) return false;
  const domain = path.slice(EXCLUDED_DOMAIN_PREFIX.length);
  return domain.length <= MAX_DOMAIN_SEGMENT_CHARS && DOMAIN_SEGMENT.test(domain);
}
