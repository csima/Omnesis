// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { judgeCaptureUrl, screenshotsEnabled } from "@omnesis/provider-web/capture-policy";
import { WEB_SOURCE_ID } from "../../web-dataset.js";
import type { DocumentPreviewService, PreviewAdmission } from "../../previews/service.js";
import type { WebCapturePolicyService } from "./capture-policy.js";

/**
 * When a browser's page screenshot may be kept as a web page's preview.
 *
 * Only while the shared policy has screenshots switched on, and only for a
 * page the policy would still let a browser capture now: an excluded or owned
 * domain, a skipped path, a pause and a page deleted for good refuse it the
 * way they refuse the page itself. The gateway's own host is the one the
 * browser addressed, which is the host the browser itself refuses to capture.
 */
export function webPreviewAdmission(
  policy: Pick<WebCapturePolicyService, "read">,
  now: () => number = Date.now,
): PreviewAdmission {
  return ({ target, requestHost }) => {
    const current = policy.read();
    if (!screenshotsEnabled(current)) {
      return {
        status: 409,
        code: "SCREENSHOTS_DISABLED",
        message: "Page screenshots are switched off in the capture policy",
      };
    }
    if (!target.sourceUrl) {
      return { status: 422, code: "PREVIEW_NOT_ALLOWED", message: "The page has no address" };
    }
    const verdict = judgeCaptureUrl(current, target.sourceUrl, {
      gatewayHost: requestHost,
      now: now(),
      externalId: target.externalId,
    });
    if (verdict.allowed) return null;
    if (verdict.reason === "removed-page") {
      return { status: 410, code: "PREVIEW_SUPPRESSED", message: "The page was deleted for good" };
    }
    return {
      status: 409,
      code: "PREVIEW_NOT_ALLOWED",
      message: `The capture policy refuses this page (${verdict.reason})`,
    };
  };
}

/** Let the Web Pages source keep browser screenshots as its pages' previews. */
export function registerWebPreviewAdmission(
  previews: Pick<DocumentPreviewService, "registerAdmission">,
  policy: Pick<WebCapturePolicyService, "read">,
): void {
  previews.registerAdmission(WEB_SOURCE_ID, webPreviewAdmission(policy));
}
