// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The fields that make a page one the extension never records: a password, a
 * one-time code, or a payment card's number, expiry or security code. Pages
 * that carry them are sign-in, verification, checkout and account pages,
 * whose text is about the user's credentials rather than content worth
 * indexing.
 *
 * Inputs are recognised by what the page declares about them — the
 * `autocomplete` tokens the HTML standard defines for these fields
 * (`one-time-code`, `cc-number`, `cc-csc`, …) — and, for card forms that
 * declare nothing, by the name or id a card field conventionally carries.
 */
export const SENSITIVE_FIELD_SELECTOR = [
  'input[type="password" i]',
  'input[autocomplete~="one-time-code" i]',
  'input[autocomplete~="current-password" i]',
  'input[autocomplete~="new-password" i]',
  'input[autocomplete*="cc-" i]',
  'input[name*="cardnumber" i]',
  'input[name*="card-number" i]',
  'input[name*="card_number" i]',
  'input[id*="cardnumber" i]',
  'input[name*="cvc" i]',
  'input[name*="cvv" i]',
  'input[id*="cvc" i]',
  'input[id*="cvv" i]',
].join(",");

/** A document or an open shadow root: anything a selector can be run against. */
type FieldRoot = Pick<ParentNode, "querySelector" | "querySelectorAll">;

/**
 * Whether `root` carries a sensitive field, looking through every open shadow
 * root beneath it as well. Closed shadow roots are invisible to the extension
 * by design, and so is their content: the extractor cannot read it either.
 */
export function hasSensitiveField(root: FieldRoot): boolean {
  if (root.querySelector(SENSITIVE_FIELD_SELECTOR)) return true;
  const elements = root.querySelectorAll("*");
  for (let i = 0; i < elements.length; i++) {
    const shadow = (elements[i] as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow && hasSensitiveField(shadow)) return true;
  }
  return false;
}
