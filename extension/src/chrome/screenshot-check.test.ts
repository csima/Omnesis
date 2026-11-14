// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { checkScreenshot, isScreenshotCheckMessage } from "./screenshot-check.js";

const URL_SHOWN = "https://shop.example.com/products/invented-lamp";
const HASH = "c".repeat(64);
const REQUEST = { type: "screenshot-check" as const, url: URL_SHOWN, contentHash: HASH };

function page(
  body: string,
  options: { focused?: boolean; href?: string; lastEmittedHash?: string | null } = {},
) {
  const { document } = parseHTML(`<!doctype html><html><body>${body}</body></html>`);
  const focused = options.focused ?? true;
  Object.assign(document, {
    visibilityState: focused ? "visible" : "hidden",
    hasFocus: () => focused,
  });
  return {
    document: document as unknown as Document,
    location: { href: options.href ?? URL_SHOWN },
    lastEmittedHash: options.lastEmittedHash === undefined ? HASH : options.lastEmittedHash,
  };
}

describe("checkScreenshot", () => {
  it("confirms a focused page still showing the capture, with nothing sensitive on it", () => {
    expect(checkScreenshot(page("<main><h1>An invented lamp</h1></main>"), REQUEST)).toEqual({
      ok: true,
    });
  });

  it("refuses a page that moved to another address on the same site", () => {
    const moved = page("<main>Sign in</main>", { href: "https://shop.example.com/signin" });
    expect(checkScreenshot(moved, REQUEST)).toEqual({ ok: false, reason: "navigated" });
  });

  it("refuses when the page is on another capture, or emitted none", () => {
    expect(checkScreenshot(page("<p>x</p>", { lastEmittedHash: "d".repeat(64) }), REQUEST)).toEqual(
      { ok: false, reason: "other-capture" },
    );
    expect(checkScreenshot(page("<p>x</p>", { lastEmittedHash: null }), REQUEST)).toEqual({
      ok: false,
      reason: "other-capture",
    });
  });

  it("refuses a hidden or unfocused page", () => {
    expect(checkScreenshot(page("<p>x</p>", { focused: false }), REQUEST)).toEqual({
      ok: false,
      reason: "not-focused",
    });
  });

  it.each([
    ['<input type="password">'],
    ['<input autocomplete="one-time-code">'],
    ['<input autocomplete="cc-number">'],
    ['<input name="cardNumber">'],
    ['<input name="cvc">'],
  ])("refuses a page carrying %s", (field) => {
    expect(checkScreenshot(page(`<form>${field}</form>`), REQUEST)).toEqual({
      ok: false,
      reason: "sensitive-field",
    });
  });

  it("refuses while an editable element is focused", () => {
    const shown = page('<textarea id="note"></textarea>');
    (shown.document.getElementById("note") as unknown as { focus(): void }).focus?.();
    Object.defineProperty(shown.document, "activeElement", {
      value: shown.document.getElementById("note"),
    });
    expect(checkScreenshot(shown, REQUEST)).toEqual({ ok: false, reason: "typing" });
  });

  it("refuses while a form control holds a typed value", () => {
    const shown = page('<input id="q" type="text" value="">');
    (shown.document.getElementById("q") as HTMLInputElement).value = "an invented query";
    expect(checkScreenshot(shown, REQUEST)).toEqual({ ok: false, reason: "typing" });
  });

  it("recognises only a well-formed check message", () => {
    expect(isScreenshotCheckMessage(REQUEST)).toBe(true);
    expect(isScreenshotCheckMessage({ type: "screenshot-check", url: URL_SHOWN })).toBe(false);
    expect(isScreenshotCheckMessage(null)).toBe(false);
  });
});
