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
 * Two kinds of rule:
 *
 * - **Shaped** rules match a credential by its own shape: a vendor prefix, a
 *   JWT's two encoded JSON segments, a private key's armour, a password in a
 *   URL or a `curl -u`, a connection-string key, an `Authorization` header
 *   with its scheme. They are precise, so they are also the rules applied to
 *   text already stored ({@link redactShapedSecrets}).
 * - **Assignment** rules match a value assigned to one of a short list of
 *   credential names (`password`, `api_key`, `DB_PASSWORD`, `<password>`,
 *   `define('DB_PASSWORD', …)`) when the value itself looks like a credential.
 *
 * Each match is replaced with {@link REDACTED_SECRET}. Redaction is
 * idempotent: redacting already-redacted text changes nothing, so the content
 * hash the gateway stores for a page the extension already redacted is the one
 * the extension computed.
 *
 * Cost is bounded by construction, not by trusting each pattern. Private keys,
 * the one multi-line rule, are matched only forward from an armour line, over
 * a bounded body. Every other rule runs one line at a time, and a line longer
 * than {@link WINDOW_CHARS} is read in overlapping windows, so no pattern ever
 * sees more than a window however it backtracks. The rules record the spans
 * they would replace; spans found in overlapping windows are merged before
 * anything is replaced, so a token on a window boundary is redacted whole and
 * once. A token longer than the overlap — a long JWT, a signed URL's token —
 * is found by a separate linear scan over the whole line for runs of token
 * characters that start like a credential.
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
 * Every shaped pattern starts with {@link from}: a lookbehind that refuses to
 * start inside a run of the characters the credential is made of, so a match
 * can start only where a run starts.
 */
const tok = (chars: string): string => String.raw`(?:\\?[${chars}])`;
const from = (chars: string): string => String.raw`(?<![\\${chars}])`;
const US = String.raw`\\?_`;
const B64URL = "A-Za-z0-9_-";
const ALNUM = "A-Za-z0-9";
const B64URL_DOT = "A-Za-z0-9_.-";

/** Longest piece of a line one pattern is run over. */
export const WINDOW_CHARS = 4096;
/** How far consecutive windows overlap; a token up to this long is seen whole in one of them. */
export const WINDOW_OVERLAP = 512;
/** Characters before a window a pattern may look back at, so a lookbehind sees what precedes it. */
const WINDOW_CONTEXT = 64;
/** Longest private key body read after an armour line. */
const MAX_KEY_CHARS = 64 * 1024;

/**
 * Characters a page can hide inside a token to break it up: zero-width
 * spaces and joiners, invisible operators and separators, the BOM, soft hyphens.
 */
const HIDDEN_CHARACTERS = /[\u00AD\u200B-\u200D\u2060-\u2064\uFEFF]/g;

/**
 * A chain of single-backtick code spans whose closing and opening ticks touch
 * (`` `ab``cd``ef` ``), which is how a token split across adjacent `<code>`
 * elements arrives. Each span's text is taken whole by a lookahead and
 * backreference, which cannot be backtracked into, so the scan is linear. The
 * first tick must not follow a tick, the last must not precede one, and the
 * first span must start with a non-space, so the gap between two separate
 * spans is never read as a span of its own.
 */
const CODE_SPAN_CHAIN =
  /(?<!`)`(?=([^`\s][^`\n]*))\1``(?:(?=([^`\n]+))\2``)*(?=([^`\n]+))\3`(?!`)/g;

/** The armour lines of a PEM or PGP private key. */
const PRIVATE_KEY_BEGIN = String.raw`\\?-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----`;
const PRIVATE_KEY_END = String.raw`\\?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----`;
/**
 * What separates the lines of a key: a line break (with the trailing spaces a
 * Markdown `<br>` leaves before it, and the blockquote or indent prefix a
 * quoted key carries after it), at most one blank line, or spaces where the
 * lines were joined into one.
 */
const KEY_SEPARATOR = String.raw`(?:[ \t]*(?:\r?\n[ \t>]*){1,2}|[ \t]+)`;
/**
 * One line of key material: a base64 chunk of at least 16 characters, a
 * shorter one as the last before the end marker, PGP's `=XXXX` checksum
 * (Markdown-escaped or not), or an armour header.
 */
const KEY_CHUNK = String.raw`(?:[A-Za-z0-9+/=]{16,}|[A-Za-z0-9+/=]{1,15}(?=${KEY_SEPARATOR}(?:\\?=[A-Za-z0-9+/]{4}${KEY_SEPARATOR})?${PRIVATE_KEY_END})|\\?=[A-Za-z0-9+/]{4}(?=${KEY_SEPARATOR}${PRIVATE_KEY_END})|(?:Proc-Type|DEK-Info|Version|Comment|Hash|Charset):[^\n]{0,200})`;
/**
 * A private key from its armour: key material only, then the end marker if
 * there is one. The body cannot contain prose, so a key with no end marker
 * stops at the first line that is not key material and the rest of the page
 * stays. Sticky: it is only ever tried where an armour line was found.
 */
const PRIVATE_KEY = new RegExp(
  String.raw`${PRIVATE_KEY_BEGIN}(?:${KEY_SEPARATOR}${KEY_CHUNK}){0,1000}(?:${KEY_SEPARATOR}${PRIVATE_KEY_END})?`,
  "y",
);

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
  "gd",
);

/** An AWS secret access key, which has no prefix of its own, after its name. */
const AWS_SECRET = new RegExp(
  String.raw`${from(ALNUM)}aws${US}secret${US}access${US}key\W{0,5}[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])`,
  "gid",
);

/** The key in an Azure storage or Service Bus connection string; the rest of the string stays. */
const CONNECTION_STRING_KEY =
  /(?<![A-Za-z0-9])(?:AccountKey|SharedAccessKey)=([A-Za-z0-9+/]{20,}={0,2})/dgi;

/**
 * The user and password in a URL's authority: `https://user:pass@host`, an
 * empty user (`redis://:pass@host`), and a password that itself holds an `@`
 * (the last `@` before the host ends it).
 */
const URL_USERINFO =
  /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/([^\s/?#@:]{0,256}:[^\s/?#]{1,256})@/dgi;

/** The user and password given to `curl -u` or `--user`. */
const CURL_USER =
  /(?:^|[ \t])(?:-u|--user)[ \t]+("[^"\n:]{0,256}:[^"\n]{0,256}"|'[^'\n:]{0,256}:[^'\n]{0,256}'|[^\s"':]{1,256}:[^\s"']{1,256})/dg;

/** An `Authorization` header with its scheme; the scheme and the credential go. */
const AUTH_HEADER =
  /(?<![A-Za-z0-9_-])(?:proxy-)?authorization\\?["']?[ \t]*:[ \t]*["']?((?:basic|bearer|token|digest|negotiate)[ \t]+[A-Za-z0-9+/=._~-]{1,512})/dgi;

/** A pattern and the capture group whose span it redacts (0 = the whole match). */
interface Rule {
  re: RegExp;
  group: number;
  /** A check on the redacted span's text; a span that fails it stays. */
  accept?: (text: string) => boolean;
}

const SHAPED_RULES: readonly Rule[] = [
  { re: SHAPED_SECRET, group: 0 },
  { re: AWS_SECRET, group: 0 },
  { re: CONNECTION_STRING_KEY, group: 1 },
  { re: URL_USERINFO, group: 1 },
  { re: CURL_USER, group: 1 },
  {
    re: AUTH_HEADER,
    group: 1,
    accept: (text) => looksLikeCredential(text.replace(/^\S+[ \t]+/, ""), true),
  },
];

/** Names whose whole identifier names a credential, compared lowercased with `-` read as `_`. */
const CREDENTIAL_NAMES = new Set([
  "password",
  "passwd",
  "pwd",
  "pass",
  "secret",
  "client_secret",
  "clientsecret",
  "api_key",
  "apikey",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "auth_token",
  "private_key",
  "privatekey",
  "secret_key",
  "secretkey",
  "aws_secret_access_key",
  "token",
]);

/** An UPPER_SNAKE environment name that ends in a credential word: `DB_PASSWORD`, `NPM_TOKEN`. */
const CREDENTIAL_ENV_NAME =
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:PASSWORD|PASS|SECRET|TOKEN|API_KEY|SECRET_KEY)$/;

/**
 * Whether an identifier names a credential: it is one of a short list of
 * names (`password`, `api_key`, `clientSecret`, `token`, …) or an UPPER_SNAKE
 * name ending in `_PASSWORD`, `_PASS`, `_SECRET`, `_TOKEN`, `_API_KEY` or
 * `_SECRET_KEY`. A name that only contains one (`token_endpoint`,
 * `secret_name`, `PRIVATE_KEY_FILE`) is not one.
 */
export function namesCredential(identifier: string): boolean {
  const name = identifier.replace(/\\/g, "");
  return (
    CREDENTIAL_NAMES.has(name.toLowerCase().replace(/-/g, "_")) || CREDENTIAL_ENV_NAME.test(name)
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

/** Well-known example passwords, which a tutorial shows and no one is protecting. */
const EXAMPLE_PASSWORD =
  /^(?:p[a@4]ss(?:w[o0]rd)?|changeme|hunter2|letmein|qwerty|admin|secret)[0-9!@#$.]*$/i;

/**
 * Whether a value assigned to a credential name looks like a credential
 * rather than code, a type, a reference, a placeholder or prose: at least
 * eight characters, at least two character classes (lower, upper, digit,
 * other), and none of:
 *
 * - a keyword, a type (`string[]`, `Optional[str]`, `Array<string>`) or a
 *   well-known example password (`P@ssw0rd!`);
 * - a reference: `$VAR`, `${…}`, `$(…)`, `%VAR%`, `{{…}}`, `<your-token>`;
 * - a call or an index on a name (`getenv("X")`, `Token::new(&key)`,
 *   `os.environ['X']`), a member access
 *   (`settings.SECRET_KEY`, `process.env.SECRET_KEY!`) or an environment name
 *   (`DB_PASSWORD`);
 * - a path (`/run/secrets/x`, `./key`, `~/.ssh/id`) or a URL;
 * - a mask or placeholder (`********`, `xxxx-xxxx`, `your-api-key`,
 *   `tok_live_EXAMPLE`), a date or a number with a unit (`3600s`).
 *
 * A value that follows an explicit authorization scheme (`Basic dXNlcjpwYXNz`)
 * skips the shape tests: base64 of a short user and password can be all letters.
 */
export function looksLikeCredential(raw: string, afterScheme = false): boolean {
  const quoted = /^(["']).*\1$/.test(raw);
  const value = quoted ? raw.slice(1, -1) : raw.replace(/[;,)\]}`*]+$/, "");
  if (value.length < 8 || value.length > 512) return false;
  const lower = value.toLowerCase();
  if (NOT_CREDENTIALS.has(lower) || EXAMPLE_PASSWORD.test(value)) return false;
  if (/^(?:\$\{|\$\(|\{\{|<)/.test(value) || value.includes("${")) return false;
  if (/^\$(?:[A-Z_][A-Z0-9_]*|[a-z_][a-z0-9_]*)$/.test(value) || /^%[A-Za-z_]\w*%$/.test(value)) {
    return false;
  }
  if (/^(?:\/|\.\/|~\/)/.test(value) || value.includes("://")) return false;
  if (/^[xX*•#._-]+$/.test(value) || /^[xX]{2,}(?:-[xX]{2,})+$/.test(value)) return false;
  if (/^(?:your|my)[-_ ]/i.test(value) || /example|changeme|placeholder|redacted/i.test(value)) {
    return false;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(value) || /^\d+(?:\.\d+)?[a-z%]{0,6}$/i.test(value)) return false;
  if (afterScheme) return true;
  if (/^[A-Za-z_$][A-Za-z_$.:]*[([]/.test(value)) return false;
  if (/^[A-Za-z_][\w.]*<.*>\??$/.test(value) || /^[A-Za-z_][\w.]*(?:\[\])+$/.test(value)) {
    return false;
  }
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[!?]*$/.test(value)) return false;
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value) && !/[0-9]/.test(value)) return false;
  if (/^[A-Za-z]+$/.test(value)) return false;
  let classes = 0;
  for (const re of [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]) if (re.test(value)) classes += 1;
  return classes >= 2;
}

/**
 * An identifier followed by an assignment: `password: `, `DB_PASSWORD=`,
 * `"api_key": `, `accessToken = `, including Markdown emphasis around the
 * separator (`**Password:** `). `==`, `===`, `!=`, `=>` and `:=` are never
 * separators. A name never starts right after `.` (a member access), `{`, `$`,
 * `:` or `-` (`${SECRET_KEY:-x}`, `arn:…:secret:…`). Only the name and
 * separator are matched; the value is read afterwards, and only for a
 * credential name.
 */
const ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_\\{$.:-])([A-Za-z][A-Za-z0-9_\\-]{0,63})(\\?["']?[ \t]*(?<![=!<>:])[:=](?![=>:])(?:[ \t]*[*_${"`"}]+)?[ \t]*)`,
  "g",
);

/** A properties key at the start of a line: `spring.datasource.password=`. */
const PROPERTIES_KEY = /^[ \t]*(?:[A-Za-z0-9_-]+\.)+([A-Za-z][A-Za-z0-9_-]*)([ \t]*[=:][ \t]*)/d;

/** An assigned value, read where its separator ends: quoted, or up to the next whitespace. */
const ASSIGNED_VALUE = /"[^"\n]{0,512}"|'[^'\n]{0,512}'|\S{1,512}(?!\S)/y;

/** PHP's `define('DB_PASSWORD', '…')`. */
const DEFINE_CALL =
  /define\(\s*(["'])([A-Za-z_][A-Za-z0-9_]{0,63})\1\s*,\s*(["'][^"'\n]{1,512}["'])/dgi;

/** An XML element named for a credential: `<password>…</password>`. */
const XML_ELEMENT = /<([A-Za-z][A-Za-z0-9_-]{0,63})>([^<\n]{1,512})<\/\1>/dg;

/** A span of the line to replace, start inclusive and end exclusive. */
type Span = [number, number];

/** The value of a credential assignment that starts at `valueStart`, as a span, or null. */
function assignedValueSpan(text: string, valueStart: number): Span | null {
  ASSIGNED_VALUE.lastIndex = valueStart;
  const value = ASSIGNED_VALUE.exec(text)?.[0];
  if (!value || value.startsWith(REDACTED_SECRET) || !looksLikeCredential(value)) return null;
  const trailing = /^["']/.test(value) ? "" : (/[;,)\]}`*]+$/.exec(value)?.[0] ?? "");
  return [valueStart, valueStart + value.length - trailing.length];
}

/** Spans of credential values assigned to credential names in `text`. */
function assignmentSpans(text: string, atLineStart: boolean): Span[] {
  const spans: Span[] = [];
  ASSIGNMENT.lastIndex = 0;
  for (let match = ASSIGNMENT.exec(text); match; match = ASSIGNMENT.exec(text)) {
    const valueStart = match.index + match[0].length;
    ASSIGNMENT.lastIndex = valueStart;
    if (!namesCredential(match[1]!)) continue;
    const span = assignedValueSpan(text, valueStart);
    if (span) {
      spans.push(span);
      ASSIGNMENT.lastIndex = span[1];
    }
  }
  if (atLineStart) {
    const key = PROPERTIES_KEY.exec(text);
    if (key && namesCredential(key[1]!)) {
      const span = assignedValueSpan(text, key[0].length);
      if (span) spans.push(span);
    }
  }
  for (const [re, nameGroup, valueGroup] of [
    [DEFINE_CALL, 2, 3],
    [XML_ELEMENT, 1, 2],
  ] as const) {
    re.lastIndex = 0;
    for (let match = re.exec(text); match; match = re.exec(text)) {
      const [start, end] = match.indices![valueGroup]!;
      if (namesCredential(match[nameGroup]!) && looksLikeCredential(match[valueGroup]!)) {
        spans.push([start, end]);
      }
    }
  }
  return spans;
}

/** Spans the shaped rules redact in `text`. */
function shapedSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const rule of SHAPED_RULES) {
    rule.re.lastIndex = 0;
    for (let match = rule.re.exec(text); match; match = rule.re.exec(text)) {
      const [start, end] = match.indices![rule.group]!;
      if (end > start && (!rule.accept || rule.accept(text.slice(start, end)))) {
        spans.push([start, end]);
      }
      if (match[0].length === 0) rule.re.lastIndex += 1;
    }
  }
  return spans;
}

/**
 * A run of the characters tokens are made of — base64 and base64url, a JWT's
 * dots, Markdown's escaping backslash — that starts where no such character
 * precedes it, so each run is scanned once. Only a run longer than the
 * window overlap can be cut by a window boundary or outgrow a window.
 */
const LONG_TOKEN_RUN = new RegExp(
  String.raw`(?<![\\A-Za-z0-9_.~+/=-])[\\A-Za-z0-9_.~+/=-]{${WINDOW_OVERLAP},}`,
  "g",
);

/**
 * How a long run starts when it is a credential with no length limit: a JWT
 * (a header, its dot, then the payload's `eyJ`), a vendor prefix, or a bearer
 * credential's token (judged by what precedes the run). Tested on the run's
 * first characters only.
 */
const LONG_TOKEN_START = new RegExp(
  String.raw`^(?:eyJ[A-Za-z0-9_\\-]{8,256}\.eyJ|gh[pousr]${US}|github${US}pat${US}|sk-(?:proj|svcacct|admin|ant)-|sk-[A-Za-z0-9]{20}|xox[abceoprs]-|xapp-|glpat-|ya29\.|hvs\.|AIza|npm${US}|hf${US}|pypi-AgEI|SG\.|dp\.(?:st|ct|sa|scim|audit)\.|lin${US}api${US}|ntn${US}|omn${US}|(?:ahk|bxt)${US}|[sr]k${US}(?:live|test)${US}|whsec${US}|GOCSPX-)`,
);
const BEARER_BEFORE = /(?:^|[^A-Za-z0-9])Bearer[ \t]+$/;

/**
 * Spans of credentials too long for the windows: every run of token
 * characters longer than the window overlap whose start is a credential's,
 * redacted as a whole run. Found by one linear scan over the whole line, so a
 * JWT, signed token or bearer credential of any length is caught wherever the
 * window boundaries fall.
 */
function longTokenSpans(line: string): Span[] {
  if (line.length < WINDOW_OVERLAP) return [];
  const spans: Span[] = [];
  LONG_TOKEN_RUN.lastIndex = 0;
  for (let match = LONG_TOKEN_RUN.exec(line); match; match = LONG_TOKEN_RUN.exec(line)) {
    const run = match[0];
    const head = run.slice(0, 320);
    const bearer =
      BEARER_BEFORE.test(line.slice(Math.max(0, match.index - 32), match.index)) &&
      /[0-9]/.test(head);
    if (bearer || LONG_TOKEN_START.test(head)) {
      spans.push([match.index, match.index + run.length]);
    }
  }
  return spans;
}

/**
 * The spans to redact in one line, found window by window. Each window
 * carries {@link WINDOW_CONTEXT} characters of the line before it for
 * lookbehinds; a match that starts in that context belongs to the previous
 * window and is skipped.
 */
function lineSpans(line: string, withAssignments: boolean): Span[] {
  const spans: Span[] = longTokenSpans(line);
  const step = WINDOW_CHARS - WINDOW_OVERLAP;
  for (let start = 0; start < line.length; start += step) {
    const from = Math.max(0, start - WINDOW_CONTEXT);
    const window = line.slice(from, start + WINDOW_CHARS);
    const found = shapedSpans(window);
    if (withAssignments) found.push(...assignmentSpans(window, start === 0));
    for (const [a, b] of found) {
      if (from + a >= start || start === 0) spans.push([from + a, from + b]);
    }
    if (start + WINDOW_CHARS >= line.length) break;
  }
  return spans;
}

/** Replace the union of `spans` in `text` with {@link REDACTED_SECRET}. */
function replaceSpans(text: string, spans: Span[]): string {
  if (spans.length === 0) return text;
  spans.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  let out = "";
  let last = 0;
  let open: Span | null = null;
  for (const span of spans) {
    if (open && span[0] <= open[1]) {
      open[1] = Math.max(open[1], span[1]);
      continue;
    }
    if (open) {
      out += text.slice(last, open[0]) + REDACTED_SECRET;
      last = open[1];
    }
    open = [span[0], span[1]];
  }
  if (open) {
    out += text.slice(last, open[0]) + REDACTED_SECRET;
    last = open[1];
  }
  return out + text.slice(last);
}

/** Redact every private key, trying the key pattern only where an armour line starts. */
function redactPrivateKeys(text: string): string {
  if (!text.includes("-----BEGIN")) return text;
  let out = "";
  let last = 0;
  for (let at = text.indexOf("-----BEGIN"); at >= 0; at = text.indexOf("-----BEGIN", at + 1)) {
    if (at < last) continue;
    const start = at > 0 && text[at - 1] === "\\" ? at - 1 : at;
    const piece = text.slice(start, start + MAX_KEY_CHARS);
    PRIVATE_KEY.lastIndex = 0;
    const match = PRIVATE_KEY.exec(piece);
    if (!match) continue;
    out += text.slice(last, start) + REDACTED_SECRET;
    last = start + match[0].length;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** Join every chain of touching code spans into one span. */
function mergeAdjacentCodeSpans(text: string): string {
  if (!text.includes("``")) return text;
  return text.replace(CODE_SPAN_CHAIN, (chain) => `\`${chain.slice(1, -1).replace(/``/g, "")}\``);
}

/** Strip the characters a page can hide inside a token, and join split code spans. */
function visibleText(text: string): string {
  return mergeAdjacentCodeSpans(text.replace(HIDDEN_CHARACTERS, ""));
}

/** Apply the line rules to every line of `text`, after its private keys. */
function redact(text: string, withAssignments: boolean): string {
  const lines = redactPrivateKeys(visibleText(text)).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 0) lines[i] = replaceSpans(line, lineSpans(line, withAssignments));
  }
  return lines.join("\n");
}

/**
 * Replace every credential recognised by its shape alone — vendor prefixes,
 * JWTs, private keys, URL and `curl -u` passwords, connection-string keys,
 * `Authorization` headers — with {@link REDACTED_SECRET}. These rules have no
 * false positives worth the name, so they are the ones applied to text
 * already stored and to addresses.
 */
export function redactShapedSecrets(text: string): string {
  if (!text) return text;
  return redact(text, false);
}

/**
 * Replace every credential in `text` with {@link REDACTED_SECRET}: the shaped
 * ones, and a credential-looking value assigned to a credential's name in a
 * `.env` file, YAML, JSON, a properties file, XML or a header.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return redact(text, true);
}
