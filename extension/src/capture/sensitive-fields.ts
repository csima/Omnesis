// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The fields that make a page one the extension never records: a password, a
 * one-time code or PIN, or a payment card's number, expiry or security code.
 * Pages that carry them are sign-in, verification, checkout and account
 * pages, whose text is about the user's credentials rather than content worth
 * indexing.
 *
 * An input is recognised by what the page declares about it — its `type`, and
 * the `autocomplete` tokens the HTML standard defines for these fields
 * (`one-time-code`, `current-password`, `cc-number`, `cc-csc`, …), compared
 * token by token — and, for forms that declare nothing, by the words in its
 * name or id (`cardNumber`, `cc_num`, `security-code`, `otp`, `totp`,
 * `passcode`, and a `pin_code` in an input that takes digits). Words
 * are matched whole, after splitting camelCase, so `discvc` or a
 * `section-acc-1` autocomplete section is not mistaken for a card field.
 */

/** `autocomplete` tokens that name a credential or payment-card field outright. */
const SENSITIVE_AUTOCOMPLETE = new Set(["one-time-code", "current-password", "new-password"]);

/** Card-number spellings found inside longer names (`creditCardNumber`, `ccnum`). */
const CARD_NUMBER_INSIDE = /card[_-]?number|cc[_-]?num/;

/** Words that name a code or card field when they stand alone in a name or id. */
const SENSITIVE_WORD =
  /(?:^|[^a-z])(?:cvc|cvv|csc|otp|totp|passcode|mfa[_-]?code|security[_-]?code|verification[_-]?code)(?=$|[^a-z])/;

/**
 * A PIN: the word `pin` followed by `code` or `number`. A `pin` alone names a
 * map pin or a pinned search as often as a secret, so it counts only together
 * with one of those words, in an input that takes a password or digits.
 */
const PIN_WORDS = /(?:^|[^a-z])pin[_-]?(?:code|number|num)(?=$|[^a-z])/;

/** A name or id split at camelCase humps and lowercased: `cardCvc` → `card_cvc`, `OTPCode` → `otp_code`. */
function words(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** Whether one input is a password, one-time-code, PIN or payment-card field. */
export function isSensitiveInput(input: Element): boolean {
  if ((input.getAttribute("type") ?? "").trim().toLowerCase() === "password") return true;
  const tokens = (input.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
  if (tokens.some((token) => SENSITIVE_AUTOCOMPLETE.has(token) || token.startsWith("cc-"))) {
    return true;
  }
  const type = (input.getAttribute("type") ?? "").trim().toLowerCase();
  const numeric =
    type === "number" ||
    type === "tel" ||
    (input.getAttribute("inputmode") ?? "").trim().toLowerCase() === "numeric";
  for (const attribute of ["name", "id"]) {
    const value = words(input.getAttribute(attribute) ?? "");
    if (!value) continue;
    if (CARD_NUMBER_INSIDE.test(value) || SENSITIVE_WORD.test(value)) return true;
    if (numeric && PIN_WORDS.test(value)) return true;
  }
  return false;
}

/** A document or an open shadow root: anything a selector can be run against. */
type FieldRoot = Pick<ParentNode, "querySelectorAll">;

/**
 * Whether `root` carries a sensitive field, looking through every open shadow
 * root beneath it as well. Closed shadow roots are invisible to the extension
 * by design, and so is their content: the extractor cannot read it either.
 */
export function hasSensitiveField(root: FieldRoot): boolean {
  const inputs = root.querySelectorAll("input");
  for (let i = 0; i < inputs.length; i++) if (isSensitiveInput(inputs[i]!)) return true;
  const elements = root.querySelectorAll("*");
  for (let i = 0; i < elements.length; i++) {
    const shadow = (elements[i] as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow && hasSensitiveField(shadow)) return true;
  }
  return false;
}
