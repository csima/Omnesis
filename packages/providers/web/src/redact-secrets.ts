// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Secret redaction for captured web pages.
 *
 * A page the user reads can show a credential in plain text: a token on a
 * developer dashboard, a key pasted into an issue, a `.env` file in a code
 * viewer. The browser extension runs every capture's title and text through
 * {@link redactSecrets} before the page leaves the browser, and the gateway runs
 * every ingested web page through it again as a backstop, so a browser with an
 * older or modified extension cannot put a credential into the corpus either.
 *
 * The rules match credentials by shape — a vendor prefix, a JWT's two encoded
 * JSON segments, a PEM armour line — or by the name it is assigned to
 * (`password: …`, `api_key=…`). Each match is replaced with
 * {@link REDACTED_SECRET}. Redaction is idempotent: redacting already-redacted
 * text changes nothing, so the content hash the gateway stores for a page the
 * extension already redacted is the one the extension computed.
 *
 * Dependency-free, so it bundles into the extension's content script unchanged.
 */

/** What every redacted credential reads as. */
export const REDACTED_SECRET = "[redacted]";

/**
 * The extension hands over Markdown, and Markdown escapes some of the
 * characters credentials are made of: Turndown writes `ghp_x` in prose as
 * `ghp\_x`. So every pattern accepts a backslash before any character it
 * matches. {@link tok} is one character of `chars`, escaped or not; {@link US}
 * is an underscore, escaped or not.
 */
const tok = (chars: string): string => String.raw`(?:\\?[${chars}])`;
const US = String.raw`\\?_`;
const B64URL = "A-Za-z0-9_-";

/**
 * Credentials recognised by their own shape. Each alternative names one
 * family; the patterns require enough random-looking characters after the
 * prefix that ordinary words do not match.
 */
const SHAPED_SECRET = new RegExp(
  [
    // An HTTP bearer credential in RFC 6750's b64token alphabet; the token must
    // carry a digit, so prose such as "Bearer authentication" is left alone.
    String.raw`\bBearer[ \t]+(?=${tok("A-Za-z_.~+/-")}*[0-9])${tok("A-Za-z0-9_.~+/-")}{12,}=*`,
    // Slack bot, user, app and refresh tokens, and incoming-webhook URLs.
    String.raw`\bxox[abceoprs]-${tok("A-Za-z0-9-")}{10,}`,
    String.raw`\bxapp-[0-9]-${tok("A-Za-z0-9-")}{10,}`,
    String.raw`hooks\.slack\.com/services/${tok("A-Za-z0-9/_-")}+`,
    // OpenAI and Anthropic style `sk-` keys.
    String.raw`\bsk-(?:proj-|ant-)?${tok(B64URL)}{16,}`,
    // A JSON Web Token: two base64url JSON objects and a signature.
    String.raw`\beyJ${tok(B64URL)}{8,}\.eyJ${tok(B64URL)}{8,}\.${tok(B64URL)}*`,
    // A PEM private key, armour to armour (or to the end of an unterminated one).
    String.raw`\\?-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)`,
    // GitHub classic and fine-grained tokens.
    String.raw`\bgh[pousr]${US}[A-Za-z0-9]{30,}`,
    String.raw`\bgithub${US}pat${US}${tok("A-Za-z0-9_")}{22,}`,
    // AWS access key ids, long-term and temporary.
    String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
    // Agent host, Stripe, Google API and GitLab keys, and Omnesis's own tokens.
    String.raw`\b(?:ahk|bxt)${US}${tok(B64URL)}{16,}`,
    String.raw`\b[sr]k${US}(?:live|test)${US}[A-Za-z0-9]{10,}`,
    String.raw`\bAIza${tok(B64URL)}{35}`,
    String.raw`\bglpat-${tok(B64URL)}{20,}`,
    String.raw`\bomn${US}${tok(B64URL)}{20,}`,
  ].join("|"),
  "g",
);

/** An AWS secret access key, which has no prefix of its own, after its name. */
const AWS_SECRET = new RegExp(
  String.raw`\baws${US}secret${US}access${US}key\W{0,5}[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])`,
  "gi",
);

/**
 * A value assigned to a credential's name on one line: `password: …`,
 * `api_key=…`, `Authorization: …`, including Markdown emphasis around the
 * separator (`**Password:** …`). The name and separator are kept so the text
 * still reads; only the value goes.
 */
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`\b(password|passwd|access${US}token|refresh${US}token|api${US}key|apikey|client${US}secret|authorization)([ \t]*[:=](?:[ \t]*[*_${"`"}]+)?[ \t]*)(?!\[redacted\])\S+`,
  "gi",
);

/** Replace every credential in `text` with {@link REDACTED_SECRET}. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(SHAPED_SECRET, REDACTED_SECRET)
    .replace(AWS_SECRET, REDACTED_SECRET)
    .replace(SECRET_ASSIGNMENT, `$1$2${REDACTED_SECRET}`);
}
