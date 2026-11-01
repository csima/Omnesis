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
 *
 * Every pattern starts with {@link from}: a lookbehind that refuses to start
 * inside a run of the characters the credential is made of. A plain `\b`
 * would let a match start at every `-`, `.` or `_` inside a long run, and
 * each start would scan to the end of the run — quadratic time on a page of
 * `eyJ-eyJ-…`. Starting only where a run starts keeps every pattern linear.
 */
const tok = (chars: string): string => String.raw`(?:\\?[${chars}])`;
const from = (chars: string): string => String.raw`(?<![\\${chars}])`;
const US = String.raw`\\?_`;
const B64URL = "A-Za-z0-9_-";
const ALNUM = "A-Za-z0-9";
const B64URL_DOT = "A-Za-z0-9_.-";

/**
 * Characters a page can hide inside a token to break it up: zero-width
 * spaces and joiners, invisible operators and separators, the BOM, soft hyphens.
 */
const HIDDEN_CHARACTERS = /[\u00AD\u200B-\u200D\u2060-\u2064\uFEFF]/g;

/**
 * Two single-backtick code spans whose closing and opening ticks touch, which
 * is how a token split across adjacent `<code>` elements arrives. The first
 * tick must not follow another tick and the last must not precede one, and
 * the first span must hold more than whitespace, so a gap between two spans
 * is never mistaken for a span of its own.
 */
const ADJACENT_CODE_SPANS = /(?<!`)`([^`\n]*[^`\s][^`\n]*)``([^`\n]+)`(?!`)/g;

/** The armour lines of a PEM or PGP private key. */
const PRIVATE_KEY_BEGIN = String.raw`\\?-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----`;
const PRIVATE_KEY_END = String.raw`\\?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----`;
/** A line break, with the blockquote or indent prefix a key quoted in Markdown carries. */
const KEY_LINE_BREAK = String.raw`\r?\n[ \t>]*`;
/**
 * A private key: its armour, then base64 chunks of at least 16 characters
 * (a shorter one only as the last before the end marker) and armour headers,
 * with at most one blank line between lines (PGP puts one after its headers),
 * then its end marker if it has one. The body cannot contain prose, so a key
 * with no end marker stops at the first line that is not key material and the
 * rest of the page stays, and a body never runs past another armour line.
 */
const KEY_SEPARATOR = String.raw`(?:(?:${KEY_LINE_BREAK}){1,2}|[ \t]+)`;
const KEY_CHUNK = String.raw`(?:[A-Za-z0-9+/=]{16,}|[A-Za-z0-9+/=]{1,15}(?=${KEY_SEPARATOR}${PRIVATE_KEY_END})|(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset):[^\n]*)`;
const PRIVATE_KEY = String.raw`${PRIVATE_KEY_BEGIN}(?:${KEY_SEPARATOR}${KEY_CHUNK}){0,1000}(?:${KEY_SEPARATOR}${PRIVATE_KEY_END})?`;

/**
 * Credentials recognised by their own shape. Each alternative names one
 * family; the patterns require enough random-looking characters after the
 * prefix that ordinary words do not match.
 */
const SHAPED_SECRET = new RegExp(
  [
    // An HTTP bearer credential in RFC 6750's b64token alphabet; the token must
    // carry a digit, so prose such as "Bearer authentication" is left alone.
    String.raw`${from(ALNUM)}Bearer[ \t]+(?=${tok("A-Za-z_.~+/-")}{0,512}[0-9])${tok("A-Za-z0-9_.~+/-")}{12,}=*`,
    // Slack bot, user, app and refresh tokens, and incoming-webhook URLs.
    String.raw`${from(`${ALNUM}-`)}xox[abceoprs]-${tok(`${ALNUM}-`)}{10,}`,
    String.raw`${from(`${ALNUM}-`)}xapp-[0-9]-${tok(`${ALNUM}-`)}{10,}`,
    String.raw`hooks\.slack\.com/services/${tok("A-Za-z0-9/_-")}+`,
    // OpenAI project, service-account and admin keys, legacy OpenAI keys
    // (alphanumeric, with a digit), and Anthropic keys.
    String.raw`${from(B64URL)}sk-(?:proj|svcacct|admin)-${tok(B64URL)}{20,}`,
    String.raw`${from(B64URL)}sk-ant-[a-z]{3,8}[0-9]{2}-${tok(B64URL)}{20,}`,
    String.raw`${from(B64URL)}sk-(?=[A-Za-z]{0,64}[0-9])[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])`,
    // A JSON Web Token: two base64url JSON objects and a signature.
    String.raw`${from(B64URL)}eyJ${tok(B64URL)}{8,}\.eyJ${tok(B64URL)}{8,}\.${tok(B64URL)}*`,
    // A PEM or PGP private key.
    PRIVATE_KEY,
    // GitHub classic and fine-grained tokens.
    String.raw`${from(B64URL)}gh[pousr]${US}[A-Za-z0-9]{30,}`,
    String.raw`${from(B64URL)}github${US}pat${US}${tok("A-Za-z0-9_")}{22,}`,
    // AWS access key ids, long-term and temporary.
    String.raw`${from(ALNUM)}(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])`,
    // Agent host, Stripe, Google API and GitLab keys, and Omnesis's own tokens.
    String.raw`${from(B64URL)}(?:ahk|bxt)${US}${tok(B64URL)}{16,}`,
    String.raw`${from(B64URL)}[sr]k${US}(?:live|test)${US}[A-Za-z0-9]{10,}`,
    String.raw`${from(B64URL)}whsec${US}[A-Za-z0-9]{20,}`,
    String.raw`${from(B64URL)}AIza${tok(B64URL)}{35}`,
    String.raw`${from(B64URL_DOT)}ya29\.${tok(B64URL)}{20,}`,
    String.raw`${from(B64URL)}GOCSPX-${tok(B64URL)}{20,}`,
    String.raw`${from(B64URL)}glpat-${tok(B64URL)}{20,}`,
    String.raw`${from(B64URL)}omn${US}${tok(B64URL)}{20,}`,
    // npm, PyPI, Hugging Face and SendGrid tokens.
    String.raw`${from(B64URL)}npm${US}[A-Za-z0-9]{30,}`,
    String.raw`${from(B64URL)}pypi-AgEI${tok(B64URL)}{40,}`,
    String.raw`${from(B64URL)}hf${US}[A-Za-z0-9]{30,}`,
    String.raw`${from(B64URL_DOT)}SG\.${tok(B64URL)}{16,}\.${tok(B64URL)}{30,}`,
    // Shopify, DigitalOcean, HashiCorp Vault, Doppler, Linear, Notion and age keys.
    String.raw`${from(B64URL)}shp(?:at|ss|ca|pa)${US}[a-fA-F0-9]{32}`,
    String.raw`${from(B64URL)}dop${US}v1${US}[a-f0-9]{64}`,
    String.raw`${from(B64URL_DOT)}hvs\.${tok(B64URL)}{24,}`,
    String.raw`${from(B64URL_DOT)}dp\.(?:st|ct|sa|scim|audit)\.(?:[a-z0-9_-]{1,64}\.)?[A-Za-z0-9]{40,}`,
    String.raw`${from(B64URL)}lin${US}api${US}[A-Za-z0-9]{40,}`,
    String.raw`${from(B64URL)}ntn${US}[A-Za-z0-9]{40,}`,
    String.raw`${from(B64URL)}AGE-SECRET-KEY-1[0-9A-Z]{58}`,
    // Discord and Telegram bot tokens.
    String.raw`${from(B64URL_DOT)}[MNO]${tok(B64URL)}{23,27}\.${tok(B64URL)}{6}\.${tok(B64URL)}{27,}`,
    String.raw`${from(`${ALNUM}:`)}[0-9]{8,10}:AA${tok(B64URL)}{30,}`,
    // An Azure AD client secret, which carries `Q~` after its fourth character.
    String.raw`${from("A-Za-z0-9_~.-")}[A-Za-z0-9_~.-]{3}[0-9]Q~${tok("A-Za-z0-9_~.-")}{31,34}(?![A-Za-z0-9_~.-])`,
  ].join("|"),
  "g",
);

/** An AWS secret access key, which has no prefix of its own, after its name. */
const AWS_SECRET = new RegExp(
  String.raw`${from(ALNUM)}aws${US}secret${US}access${US}key\W{0,5}[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])`,
  "gi",
);

/** The key in an Azure storage or Service Bus connection string; the rest of the string stays. */
const CONNECTION_STRING_KEY =
  /(?<![A-Za-z0-9])(AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{20,}={0,2}/gi;

/** The user and password in a URL's authority: `https://user:pass@host`. */
const URL_USERINFO =
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#@:]{1,256}:[^\s/?#@]{1,256}@/gi;

/** The user and password given to `curl -u` or `--user`. */
const CURL_USER =
  /((?:^|[ \t])(?:-u|--user)[ \t]+)(?:"[^"\n:]*:[^"\n]*"|'[^'\n:]*:[^'\n]*'|[^\s"':]+:[^\s"']+)/gm;

/** Replace every credential recognised by its shape alone. */
function redactShaped(text: string): string {
  return text
    .replace(SHAPED_SECRET, REDACTED_SECRET)
    .replace(AWS_SECRET, REDACTED_SECRET)
    .replace(CONNECTION_STRING_KEY, `$1=${REDACTED_SECRET}`)
    .replace(URL_USERINFO, `$1${REDACTED_SECRET}@`)
    .replace(CURL_USER, `$1${REDACTED_SECRET}`);
}

/**
 * An identifier followed by an assignment: `password: `, `DB_PASSWORD=`,
 * `"api_key": `, `accessToken = `, including Markdown emphasis around the
 * separator (`**Password:** `). `==`, `===`, `!=`, `=>` and `:=`'s colon are
 * never separators. Only the name and separator are matched; the value is
 * read afterwards, and only for a name that names a credential, so the scan
 * costs the length of the text however many names it holds.
 */
const ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_\\-])([A-Za-z][A-Za-z0-9_\\-]{0,63})(\\?["']?[ \t]*(?<![=!<>:])[:=](?![=>])(?:[ \t]*[*_${"`"}]+)?[ \t]*)`,
  "g",
);

/** An assigned value, read where its separator ends: quoted, or up to the next whitespace. */
const ASSIGNED_VALUE = /"[^"\n]{0,4096}"|'[^'\n]{0,4096}'|\S{1,4096}/y;

/** The words of an identifier: `DB_PASSWORD` → `db password`, `accessToken` → `access token`. */
function identifierWords(identifier: string): string[] {
  return identifier
    .replace(/\\/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean);
}

const CREDENTIAL_WORDS = new Set([
  "password",
  "passwd",
  "passphrase",
  "passcode",
  "pwd",
  "pass",
  "secret",
  "token",
  "apikey",
  "authorization",
  "credential",
  "credentials",
]);
/** A cheap first test: every credential name contains one of these. */
const CREDENTIAL_HINT = /pass|pwd|secret|token|key|auth|credential/i;
const CREDENTIAL_PAIRS = new Set([
  "api key",
  "private key",
  "secret key",
  "access key",
  "auth key",
]);

/**
 * Whether an identifier names a credential: one of its words is a credential
 * word (`API_TOKEN_V2`, `DB_PASS`, `clientSecret`), a word ends in `password`
 * (`PGPASSWORD`), or two adjacent words name one (`privateKey`, `x-api-key`).
 */
export function namesCredential(identifier: string): boolean {
  if (!CREDENTIAL_HINT.test(identifier)) return false;
  const words = identifierWords(identifier);
  return words.some(
    (word, index) =>
      CREDENTIAL_WORDS.has(word) ||
      word.endsWith("password") ||
      (index > 0 && CREDENTIAL_PAIRS.has(`${words[index - 1]} ${word}`)),
  );
}

/** Values that are a type, a keyword or a placeholder, never a credential. */
const NOT_CREDENTIALS = new Set([
  "null",
  "undefined",
  "true",
  "false",
  "none",
  "nil",
  "string",
  "number",
  "boolean",
  "integer",
  "object",
  "unknown",
  "required",
  "optional",
  "redacted",
]);

/**
 * Whether a value assigned to a credential name looks like a credential
 * rather than code, a type, a reference or prose: at least eight characters,
 * at least two character classes (lower, upper, digit, other), and none of a
 * keyword, a type (`string[]`, `Optional[str]`, `Array<string>`), a variable or
 * template reference (`$DB_PASS`, `${{ secrets.X }}`, `{{ .Values.x }}`,
 * `<your-token>`), a call (`getenv("X")`), an indexing or bracketed
 * expression (`os.environ['X']`), a member access (`settings.SECRET_KEY`), an environment variable name (`DB_PASSWORD`), an
 * operator or a masked placeholder (`********`). A value that follows an
 * explicit authorization scheme (`Basic dXNlcjpwYXNz`) needs only the length
 * and none of those: base64 of a short user and password can be all letters.
 */
export function looksLikeCredential(raw: string, afterScheme = false): boolean {
  const value = raw.replace(/^["']|["']$/g, "").replace(/[;,)\]}]+$/, "");
  if (value.length < 8 || value.length > 4096) return false;
  if (NOT_CREDENTIALS.has(value.toLowerCase())) return false;
  if (/^[$%<{!&|>=@#]/.test(value) || value.includes("${") || value.includes("{{")) return false;
  if (/[()[\]{}<>'"`]/.test(value)) return false;
  if (/^[A-Za-z_][\w.]*(?:<[^>]*>|\[[^\]]*\])+\??$/.test(value)) return false;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false;
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value) && !/[0-9]/.test(value)) return false;
  if (/^([*•x.#-])\1*$/i.test(value)) return false;
  if (afterScheme) return true;
  if (/^[A-Za-z]+$/.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value));
  return classes.length >= 2;
}

/** An authorization scheme followed by its credential. */
const AUTH_SCHEME = /^(basic|bearer|token|digest|negotiate)[ \t]+(\S+)/i;

/**
 * Redact the value of every assignment whose name names a credential and
 * whose value looks like one. An authorization scheme goes with its
 * credential. A value's trailing `;`, `,` or closing bracket stays.
 */
function redactAssignments(text: string): string {
  let out = "";
  let last = 0;
  ASSIGNMENT.lastIndex = 0;
  for (let match = ASSIGNMENT.exec(text); match; match = ASSIGNMENT.exec(text)) {
    const [whole, identifier] = match;
    const valueStart = match.index + whole.length;
    ASSIGNMENT.lastIndex = valueStart;
    if (!namesCredential(identifier!)) continue;
    ASSIGNED_VALUE.lastIndex = valueStart;
    const rawValue = ASSIGNED_VALUE.exec(text)?.[0];
    if (!rawValue || rawValue.startsWith(REDACTED_SECRET)) continue;
    let value = rawValue;
    if (!/^["']/.test(rawValue)) {
      const scheme = AUTH_SCHEME.exec(text.slice(valueStart, valueStart + 4200));
      if (scheme) value = scheme[0];
    }
    const scheme = AUTH_SCHEME.exec(value);
    if (!looksLikeCredential(scheme?.[2] ?? value, scheme !== null)) continue;
    const trailing = /^["']/.test(value) ? "" : (/[;,)\]}]+$/.exec(value)?.[0] ?? "");
    out += text.slice(last, valueStart) + REDACTED_SECRET;
    last = valueStart + value.length - trailing.length;
    ASSIGNMENT.lastIndex = last;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** A Markdown table header cell that names a credential column. */
const SECRET_COLUMN =
  /^(?:password|passwd|passphrase|pwd|secret|secret key|private key|api key|apikey|client secret|access key|credential|credentials)$/i;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const CELL_DIVIDER = /(?<!\\)\|/;

/** Normalize a header cell for {@link SECRET_COLUMN}: no escapes, emphasis or code ticks, one space between words. */
function headerName(cell: string): string {
  return cell
    .replace(/[\\*`]/g, "")
    .replace(/[\s_-]+/g, " ")
    .trim();
}

/** Redact each cell under a credential-named column of a Markdown table whose value looks like a credential. */
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
        const cell = cells[index]?.replace(/\\/g, "").replace(/`/g, "").trim();
        if (!cell || !looksLikeCredential(cell)) continue;
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

/** Strip the characters a page can hide inside a token, and join split code spans. */
function visibleText(text: string): string {
  return mergeAdjacentCodeSpans(text.replace(HIDDEN_CHARACTERS, ""));
}

/**
 * Replace every credential recognised by its shape alone — vendor prefixes,
 * JWTs, private keys, URL and `curl -u` passwords, connection-string keys —
 * with {@link REDACTED_SECRET}. These rules have no false positives worth
 * the name, so they are the ones applied to text already stored.
 */
export function redactShapedSecrets(text: string): string {
  if (!text) return text;
  return redactShaped(visibleText(text));
}

/**
 * Replace every credential in `text` with {@link REDACTED_SECRET}: the shaped
 * ones, and a credential-looking value assigned to a credential's name in a
 * `.env` file, YAML, JSON, a header or a table column.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return redactTableColumns(redactAssignments(redactShaped(visibleText(text))));
}
