// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The page's own answer to "may the worker shoot you now, as this capture?",
 * asked just before a screenshot. Only the page can see its DOM, so this is
 * where the screenshot honours what the text capture honours and more: the
 * page must still be at the address and on the capture the worker is about to
 * illustrate, focused and visible, with no password, one-time-code or card
 * field, and nothing the user is typing — no focused editable element, no form
 * control whose value was typed.
 */

export const SCREENSHOT_CHECK_TYPE = "screenshot-check";

/** Worker → page: may the page be shot as the capture of `contentHash` at `url`? */
export interface ScreenshotCheckMessage {
  type: typeof SCREENSHOT_CHECK_TYPE;
  url: string;
  contentHash: string;
}

/**
 * Page → worker: this page is visible and focused again after a capture, so a
 * screenshot its tab missed may be tried now. Carries nothing: the worker
 * knows the tab from the sender, and asks the page again before any shot.
 */
export const SCREENSHOT_IN_VIEW_TYPE = "screenshot-in-view";

export function isScreenshotInViewMessage(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === SCREENSHOT_IN_VIEW_TYPE
  );
}

export type ScreenshotCheckRefusal =
  "navigated" | "other-capture" | "not-focused" | "sensitive-field" | "typing";

export type ScreenshotCheckResult = { ok: true } | { ok: false; reason: ScreenshotCheckRefusal };

export function isScreenshotCheckMessage(value: unknown): value is ScreenshotCheckMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<ScreenshotCheckMessage>;
  return (
    message.type === SCREENSHOT_CHECK_TYPE &&
    typeof message.url === "string" &&
    typeof message.contentHash === "string"
  );
}

/** Fields whose contents must never appear in a screenshot. */
const SENSITIVE_FIELDS = [
  'input[type="password"]',
  '[autocomplete~="one-time-code"]',
  '[autocomplete*="cc-"]',
  'input[name*="card" i][name*="number" i]',
  'input[name*="cvc" i]',
  'input[name*="cvv" i]',
].join(",");

/** Input types that hold no typed text. */
const UNTYPED_INPUTS = new Set([
  "button",
  "submit",
  "reset",
  "image",
  "checkbox",
  "radio",
  "file",
  "hidden",
  "range",
  "color",
]);

function isEditable(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    return !UNTYPED_INPUTS.has(((element as HTMLInputElement).type || "text").toLowerCase());
  }
  const editable = element.getAttribute("contenteditable");
  return editable !== null && editable.toLowerCase() !== "false";
}

function holdsTypedValue(document: Document): boolean {
  for (const element of document.querySelectorAll("input, textarea")) {
    const control = element as HTMLInputElement | HTMLTextAreaElement;
    if (element.tagName.toLowerCase() === "input" && UNTYPED_INPUTS.has(control.type)) continue;
    if ((control.value ?? "") !== (control.defaultValue ?? "")) return true;
  }
  return false;
}

export function checkScreenshot(
  page: {
    document: Document;
    location: Pick<Location, "href">;
    /** The content hash of the last capture this page emitted, if any. */
    lastEmittedHash: string | null;
  },
  request: ScreenshotCheckMessage,
): ScreenshotCheckResult {
  const { document } = page;
  if (page.location.href !== request.url) return { ok: false, reason: "navigated" };
  if (page.lastEmittedHash !== request.contentHash) return { ok: false, reason: "other-capture" };
  if (document.visibilityState !== "visible" || !document.hasFocus()) {
    return { ok: false, reason: "not-focused" };
  }
  if (document.querySelector(SENSITIVE_FIELDS) !== null) {
    return { ok: false, reason: "sensitive-field" };
  }
  const active = document.activeElement;
  if ((active && active !== document.body && isEditable(active)) || holdsTypedValue(document)) {
    return { ok: false, reason: "typing" };
  }
  return { ok: true };
}
