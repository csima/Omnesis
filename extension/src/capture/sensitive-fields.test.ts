// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { hasSensitiveField } from "./sensitive-fields.js";

/** Fictional pages only: an invented shop, newsletter and account form. */
function page(body: string): Document {
  return parseHTML(`<!doctype html><html><body>${body}</body></html>`)
    .document as unknown as Document;
}

describe("hasSensitiveField", () => {
  it.each([
    ["a password input", '<input type="password" name="pw">'],
    ["a password input typed in capitals", '<input type="PASSWORD">'],
    ["a one-time-code input", '<input autocomplete="one-time-code" inputmode="numeric">'],
    [
      "a password input by its autocomplete token",
      '<input type="text" autocomplete="current-password">',
    ],
    ["a new-password input", '<input autocomplete="new-password">'],
    ["a card number by its autocomplete token", '<input autocomplete="cc-number">'],
    ["a sectioned card expiry", '<input autocomplete="billing cc-exp">'],
    ["a card security code", '<input autocomplete="cc-csc">'],
    ["a card number named for it", '<input name="cardNumber">'],
    ["a card number with an id for it", '<input id="cardnumber-field">'],
    ["a CVC named for it", '<input name="card_cvc">'],
    ["a CVV with an id for it", '<input id="checkout-cvv">'],
    ["a camelCase CVC name", '<input name="cardCvc">'],
    ["a card number inside a longer name", '<input name="creditCardNumber">'],
    ["a cc_num name", '<input name="cc_num">'],
    ["a ccnum id", '<input id="ccnum">'],
    ["a security code name", '<input name="security-code">'],
    ["a CSC name", '<input name="card_csc">'],
    ["an OTP name", '<input name="otp">'],
    ["an OTPCode id", '<input id="OTPCode">'],
    ["a verification code name", '<input name="verification_code">'],
    ["a numeric PIN code", '<input name="pin_code" inputmode="numeric">'],
    ["a PIN number in a number input", '<input type="number" id="pinNumber">'],
    ["a passcode name", '<input name="passcode">'],
    ["an MFA code name", '<input name="mfa_code">'],
    ["a TOTP name", '<input id="totp">'],
  ])("finds %s", (_label, field) => {
    expect(hasSensitiveField(page(`<form>${field}</form>`))).toBe(true);
  });

  it("finds a card field inside an open shadow root, nested two deep", () => {
    const doc = page('<div id="outer"></div>');
    const outer = doc.getElementById("outer")!.attachShadow({ mode: "open" });
    outer.innerHTML = '<section><div id="inner"></div></section>';
    const innerHost = outer.querySelector("#inner")!;
    const inner = innerHost.attachShadow({ mode: "open" });
    inner.innerHTML = '<input autocomplete="cc-number">';
    expect(hasSensitiveField(doc)).toBe(true);
  });

  it.each([
    [
      "an autocomplete section that only contains cc-",
      '<input autocomplete="section-acc-1 email">',
    ],
    ["a name with cvc inside a word", '<input name="discvc">'],
    ["a shipping field", '<input name="shipping_method">'],
    ["a spinner", '<input id="spinner">'],
    ["an otpauth label", '<input name="otpauthor">'],
    ["a bare pin", '<input name="pin">'],
    ["a pin-search box", '<input type="search" name="pin-search">'],
    ["a map pin label", '<input name="map_pin_label">'],
    ["a postal pin code in a text input", '<input type="text" name="pin_code">'],
  ])("does not mistake %s for a sensitive field", (_label, field) => {
    expect(hasSensitiveField(page(`<form>${field}</form>`))).toBe(false);
  });

  it("passes an ordinary form and an ordinary shadow root", () => {
    const doc = page(
      '<form><input type="email" name="newsletter"><input type="search" name="q"><textarea name="comment"></textarea></form><div id="widget"></div>',
    );
    const shadow = doc.getElementById("widget")!.attachShadow({ mode: "open" });
    shadow.innerHTML = '<input type="text" name="city" autocomplete="address-level2">';
    expect(hasSensitiveField(doc)).toBe(false);
  });
});
