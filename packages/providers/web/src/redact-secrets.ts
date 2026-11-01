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

/** Characters a page can hide inside a token to break it up: zero-width spaces and joiners, the BOM, soft hyphens. */
const HIDDEN_CHARACTERS = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

/** Two code spans with nothing between them, which is how a token split across `<code>` elements arrives. */
const ADJACENT_CODE_SPANS = /`([^`\n]+)``([^`\n]+)`/g;

/** The armour line of a PEM or PGP private key. */
const PRIVATE_KEY_BEGIN = String.raw`\\?-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----`;
const PRIVATE_KEY_END = String.raw`\\?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----`;
/**
 * The body of a private key whose end marker is missing: armour headers and
 * base64 lines, with at most one blank line between them (PGP puts one after
 * its headers). The first line of prose ends it, so the rest of the page stays.
 */
const PRIVATE_KEY_BODY = String.raw`(?:(?:\r?\n){1,2}(?:[A-Za-z0-9+/=]{8,}|(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset):[^\n]*)|[ \t]+[A-Za-z0-9+/=]{8,}){0,400}`;

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
    // A PEM or PGP private key, armour to armour, or to the end of its body.
    String.raw`${PRIVATE_KEY_BEGIN}[\s\S]*?${PRIVATE_KEY_END}`,
    String.raw`${PRIVATE_KEY_BEGIN}${PRIVATE_KEY_BODY}`,
    // GitHub classic and fine-grained tokens.
    String.raw`\bgh[pousr]${US}[A-Za-z0-9]{30,}`,
    String.raw`\bgithub${US}pat${US}${tok("A-Za-z0-9_")}{22,}`,
    // AWS access key ids, long-term and temporary.
    String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
    // Agent host, Stripe, Google API and GitLab keys, and Omnesis's own tokens.
    String.raw`\b(?:ahk|bxt)${US}${tok(B64URL)}{16,}`,
    String.raw`\b[sr]k${US}(?:live|test)${US}[A-Za-z0-9]{10,}`,
    String.raw`\bwhsec${US}[A-Za-z0-9]{20,}`,
    String.raw`\bAIza${tok(B64URL)}{35}`,
    String.raw`\bya29\.${tok(B64URL)}{20,}`,
    String.raw`\bGOCSPX-${tok(B64URL)}{20,}`,
    String.raw`\bglpat-${tok(B64URL)}{20,}`,
    String.raw`\bomn${US}${tok(B64URL)}{20,}`,
    // npm, PyPI, Hugging Face and SendGrid tokens.
    String.raw`\bnpm${US}[A-Za-z0-9]{30,}`,
    String.raw`\bpypi-AgEI${tok(B64URL)}{40,}`,
    String.raw`\bhf${US}[A-Za-z0-9]{30,}`,
    String.raw`\bSG\.${tok(B64URL)}{16,}\.${tok(B64URL)}{30,}`,
    // Discord and Telegram bot tokens.
    String.raw`\b[MNO]${tok(B64URL)}{23,27}\.${tok(B64URL)}{6}\.${tok(B64URL)}{27,}`,
    String.raw`\b[0-9]{8,10}:AA${tok(B64URL)}{30,}`,
    // An Azure AD client secret, which carries `Q~` after its fourth character.
    String.raw`(?<![A-Za-z0-9_~.-])[A-Za-z0-9_~.-]{3}[0-9]Q~${tok("A-Za-z0-9_~.-")}{31,34}(?![A-Za-z0-9_~.-])`,
  ].join("|"),
  "g",
);

/** An AWS secret access key, which has no prefix of its own, after its name. */
const AWS_SECRET = new RegExp(
  String.raw`\baws${US}secret${US}access${US}key\W{0,5}[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])`,
  "gi",
);

/** The key in an Azure storage or Service Bus connection string; the rest of the string stays. */
const CONNECTION_STRING_KEY = /\b(AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{20,}={0,2}/gi;

/** The user and password in a URL's authority: `https://user:pass@host`. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]+:[^\s/?#@]+@/gi;

/** The user and password given to `curl -u` or `--user`. */
const CURL_USER =
  /((?:^|[ \t])(?:-u|--user)[ \t]+)(?:"[^"\n:]*:[^"\n]*"|'[^'\n:]*:[^'\n]*'|[^\s"':]+:[^\s"']+)/gm;

/** Names a credential is assigned to, longest first; underscores may arrive Markdown-escaped. */
const SECRET_NAMES = [
  "x-api-key",
  "client_secret",
  "access_token",
  "refresh_token",
  "auth_token",
  "id_token",
  "private_key",
  "secret_key",
  "authorization",
  "passphrase",
  "password",
  "passwd",
  "api_key",
  "api-key",
  "apikey",
  "secret",
  "token",
  "pwd",
].map((name) => name.replaceAll("_", US));

/**
 * A value assigned to a credential's name on one line, in a `.env` file, YAML,
 * JSON or a header: `DB_PASSWORD=…`, `"api_key": "…"`, `Authorization: Basic …`,
 * including Markdown emphasis around the separator (`**Password:** …`). A name
 * may carry a prefix (`GITHUB_ACCESS_TOKEN`). An authorization scheme is taken
 * with its credential. The name and separator are kept so the text still
 * reads; only the value goes.
 */
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9])(${SECRET_NAMES.join("|")})(\\?["']?[ \t]*[:=](?:[ \t]*[*_${"`"}]+)?[ \t]*)(?!\[redacted\])(?:(?:basic|bearer|token|digest|negotiate)[ \t]+(?!\[redacted\]))?(?:"[^"\n]*"|'[^'\n]*'|\S+)`,
  "gi",
);

/** A Markdown table header cell that names a credential column. */
const SECRET_COLUMN =
  /^(?:password|passwd|passphrase|pwd|secret|secret key|private key|token|access token|api key|apikey|client secret|credential|credentials)$/i;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const CELL_DIVIDER = /(?<!\\)\|/;

/** Normalize a header cell for {@link SECRET_COLUMN}: no escapes, emphasis or code ticks, one space between words. */
function headerName(cell: string): string {
  return cell
    .replace(/[\\*`]/g, "")
    .replace(/[\s_-]+/g, " ")
    .trim();
}

/** Redact every cell under a credential-named column of a Markdown table. */
function redactTableColumns(text: string): string {
  if (!text.includes("|")) return text;
  const lines = text.split("\n");
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i]!.trimStart().startsWith("|") || !TABLE_SEPARATOR.test(lines[i + 1]!)) continue;
    const columns = lines[i]!.split(CELL_DIVIDER)
      .map((cell, index) => (SECRET_COLUMN.test(headerName(cell)) ? index : -1))
      .filter((index) => index > 0);
    let row = i + 2;
    for (; row < lines.length && lines[row]!.trimStart().startsWith("|"); row++) {
      if (columns.length === 0) continue;
      const cells = lines[row]!.split(CELL_DIVIDER);
      for (const index of columns) {
        const cell = cells[index];
        if (cell === undefined || !cell.trim() || cell.trim() === REDACTED_SECRET) continue;
        cells[index] = ` ${REDACTED_SECRET} `;
      }
      lines[row] = cells.join("|");
    }
    i = row - 1;
  }
  return lines.join("\n");
}

/** Join code spans that touch, until none do. */
function mergeAdjacentCodeSpans(text: string): string {
  if (!text.includes("``")) return text;
  let previous: string;
  let merged = text;
  do {
    previous = merged;
    merged = merged.replace(ADJACENT_CODE_SPANS, "`$1$2`");
  } while (merged !== previous);
  return merged;
}

/** Replace every credential in `text` with {@link REDACTED_SECRET}. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  const visible = mergeAdjacentCodeSpans(text.replace(HIDDEN_CHARACTERS, ""));
  return redactTableColumns(
    visible
      .replace(SHAPED_SECRET, REDACTED_SECRET)
      .replace(AWS_SECRET, REDACTED_SECRET)
      .replace(CONNECTION_STRING_KEY, `$1=${REDACTED_SECRET}`)
      .replace(URL_USERINFO, `$1${REDACTED_SECRET}@`)
      .replace(CURL_USER, `$1${REDACTED_SECRET}`)
      .replace(SECRET_ASSIGNMENT, `$1$2${REDACTED_SECRET}`),
  );
}
