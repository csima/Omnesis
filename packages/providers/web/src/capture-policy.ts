// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { hostIsOwned } from "@omnesis/core/url-normalize";

/**
 * The capture policy of the Web Pages source — the contract between the
 * gateway, which owns it, and every paired browser, which enforces it.
 *
 * Capture settings are stored once, on the gateway, so a domain excluded in one
 * browser is excluded in all of them, a pause pauses every browser, and a page
 * the user deleted "for good" is never captured again anywhere. Browsers read
 * the policy over HTTP with their `write:web` token, cache it, and refuse to
 * capture until they hold one. This module is dependency-free apart from core's
 * browser-safe URL helpers, so it bundles into the extension's service worker
 * unchanged.
 */

/** A shared capture pause. `until: null` pauses until someone resumes. */
export interface WebCapturePause {
  until: number | null;
}

/** Built-in privacy rules every browser applies on top of the exclusion list. */
export interface WebCaptureRules {
  /**
   * Skip a page whose DOM carries a sensitive field: a password, a one-time
   * code or a payment card field, in the document or in an open shadow root.
   * Sign-in, verification, checkout and account pages carry them.
   */
  skipPasswordForms: boolean;
  /** Skip a page whose URL path contains one of these segments (case-insensitive, whole segment). */
  skipPathSegments: string[];
}

/** The operator-editable half of the policy, as the gateway stores it. */
export interface WebCaptureSettings {
  pause: WebCapturePause | null;
  /** Bare lowercase hostnames; an entry also covers every subdomain. */
  excludedDomains: string[];
}

/** The wire shape of `GET /web-capture-policy`. */
export interface WebCapturePolicy extends WebCaptureSettings {
  /** ISO time the settings last changed; empty when they were never edited. */
  updatedAt: string;
  /** Hosts a dedicated source already covers; the gateway aggregates them from the collector. */
  ownedDomains: string[];
  /**
   * Hosts of the operator's own tools — an agent host and the web apps its
   * agents serve — that no browser captures, from the gateway's
   * `webCapture.ownSites` setting. Each entry also covers its subdomains.
   * Absent from older gateways, which read as none.
   */
  ownSites?: string[];
  rules: WebCaptureRules;
  /** External ids (SHA-256 of the normalized URL) of pages deleted with "never capture again". */
  removedPages: string[];
  /** True when `removedPages` was cut at the response cap; the gateway still refuses the rest on ingest. */
  removedPagesTruncated: boolean;
}

export const EMPTY_WEB_CAPTURE_SETTINGS: WebCaptureSettings = { pause: null, excludedDomains: [] };

/**
 * Conservative defaults: path segments that name authentication, payment,
 * account-management and credential flows — sign-in, multi-factor, API keys
 * and access tokens — where the rendered page is a form about the user or
 * shows a secret, rather than content worth indexing. Every browser applies
 * these whatever list a gateway serves, so a gateway can add segments but
 * never remove one. A segment that is also an ordinary word
 * ({@link GENERIC_SKIP_SEGMENTS}) is applied only where an account page puts
 * it; see {@link pathIsSkippedByRules}.
 */
export const DEFAULT_WEB_CAPTURE_RULES: WebCaptureRules = {
  skipPasswordForms: true,
  skipPathSegments: [
    "login",
    "log-in",
    "log_in",
    "logout",
    "signin",
    "sign-in",
    "sign_in",
    "signup",
    "sign-up",
    "sign_up",
    "register",
    "password",
    "reset-password",
    "forgot-password",
    "oauth",
    "oauth2",
    "authorize",
    "authenticate",
    "sso",
    "saml",
    "mfa",
    "2fa",
    "two-factor",
    "security_credentials",
    "api-tokens",
    "access-tokens",
    "personal-access-tokens",
    "api-keys",
    "apikeys",
    "api_keys",
    "checkout",
    "payment",
    "payments",
    "billing",
  ],
};

/**
 * Segments that are ordinary words as well as account pages: an article on
 * passwords, a library's `secrets` module, a `keys` command, a file under
 * `src/auth/`. They refuse a page only as one of its first two segments
 * (`/checkout`, `/vault/secrets`) or directly under an account area
 * (`/settings/tokens`), and never on a code host's file view or a
 * documentation, wiki or blog page.
 */
export const GENERIC_SKIP_SEGMENTS: ReadonlySet<string> = new Set([
  "auth",
  "keys",
  "token",
  "tokens",
  "password",
  "secrets",
  "credentials",
  "payment",
  "payments",
  "billing",
  "checkout",
  "register",
]);

/** Segments under which a generic word names the account's own page. */
const ACCOUNT_AREAS = new Set([
  "settings",
  "account",
  "accounts",
  "console",
  "dashboard",
  "admin",
  "user",
  "profile",
]);

/** Segments that mark a code host's file view. */
const CODE_VIEW_SEGMENTS = new Set(["blob", "tree", "raw", "src", "-"]);

/** Segments and host labels that mark documentation, a wiki or a blog. */
const READING_SEGMENTS = new Set([
  "docs",
  "doc",
  "documentation",
  "wiki",
  "library",
  "reference",
  "guide",
  "guides",
  "manual",
  "blog",
  "articles",
  "help",
  "learn",
  "commands",
  "tutorial",
  "tutorials",
  "faq",
]);
const READING_HOST =
  /^(?:docs?|developers?|wiki|learn|help|support|blog)\.|(?:^|\.)wikipedia\.org$/;

/** Consecutive segments that name a sign-in page together. */
const SKIPPED_SEGMENT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["session", "new"],
  ["sessions", "new"],
];

/**
 * Sites every browser skips whatever/**
 * Sites every browser skips whatever/**
 * Sites every browser skips whatever the policy says, even before any
 * collector has announced the domains its sources own: mail, messaging,
 * sign-in and password-manager sites, whose pages are private correspondence
 * or credentials. Each entry also covers its subdomains.
 */
export const BUILT_IN_SKIP_DOMAINS: readonly string[] = [
  "mail.google.com",
  "chat.google.com",
  "messages.google.com",
  "voice.google.com",
  "accounts.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "outlook.office365.com",
  "login.live.com",
  "login.microsoftonline.com",
  "teams.microsoft.com",
  "mail.yahoo.com",
  "proton.me",
  "protonmail.com",
  "icloud.com",
  "fastmail.com",
  "outlook.cloud.microsoft",
  "teams.live.com",
  "slack.com",
  "web.whatsapp.com",
  "web.telegram.org",
  "messenger.com",
  "discord.com",
  "discordapp.com",
  "1password.com",
  "my.1password.eu",
  "bitwarden.com",
  "vault.bitwarden.eu",
  "lastpass.com",
  "dashlane.com",
  "keepersecurity.com",
  "chat.reddit.com",
];

/**
 * Sites whose private messages live under one path of an otherwise public
 * site: every browser skips that path, on the site and its subdomains.
 */
export const BUILT_IN_SKIP_PAGES: ReadonlyArray<readonly [domain: string, pathPrefix: string]> = [
  ["facebook.com", "/messages"],
  ["linkedin.com", "/messaging"],
  ["x.com", "/messages"],
  ["twitter.com", "/messages"],
  ["instagram.com", "/direct"],
  ["reddit.com", "/message"],
];

/** A link's keyword segment that is followed by a credential: `/reset/<token>`, `/verify-email/<token>`. */
const TOKEN_LINK_KEYWORD =
  /^(?:reset|verify|invite|magic|activate|confirm|accept-invitation)(?:[-_](?:password|email|account|link|invite|invitation))?$/;

/**
 * Whether a segment looks like a credential rather than a name: at least 16
 * base64url or hex characters, of at least two classes (letters and digits,
 * or both cases), and not a hyphenated lowercase slug (`my-first-talk`).
 */
function segmentLooksLikeToken(segment: string): boolean {
  if (segment.length < 16 || !/^[A-Za-z0-9_\-=.~]+$/.test(segment)) return false;
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(segment) && !/[0-9]/.test(segment)) return false;
  const digits = /[0-9]/.test(segment);
  const letters = /[A-Za-z]/.test(segment);
  return (digits && letters) || (/[a-z]/.test(segment) && /[A-Z]/.test(segment));
}

/**
 * The segments of a path as the rules compare them: decoded, with matrix
 * parameters (`;jsessionid=…`) stripped and empty segments (`//`) dropped.
 * Case is kept so a token's shape can be judged; compare lowercased.
 */
function pathSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .map((raw) => {
      let segment = raw;
      try {
        segment = decodeURIComponent(segment);
      } catch {
        // A malformed escape is compared literally.
      }
      return segment.split(";")[0]!;
    })
    .filter(Boolean);
}

/**
 * Whether `pathname` is one every browser skips on its shape alone, whatever
 * the policy: a Cloudflare Access sign-in or token exchange (`/cdn-cgi/access`),
 * or a link that carries its own credential (`/reset/<token>`).
 */
export function pathIsSecretLink(pathname: string): boolean {
  const segments = pathSegments(pathname);
  return segments.some((segment, index) => {
    const lower = segment.toLowerCase();
    if (lower === "cdn-cgi" && segments[index + 1]?.toLowerCase().split(".")[0] === "access") {
      return true;
    }
    const next = segments[index + 1];
    return TOKEN_LINK_KEYWORD.test(lower) && next !== undefined && segmentLooksLikeToken(next);
  });
}

/** A host as the rules compare it: lowercase, without the trailing dot of a fully qualified name. */
export function comparableHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, "");
}

/** Upper bound on `removedPages` in one policy response. */
export const REMOVED_PAGES_RESPONSE_CAP = 5_000;

/** Longest hostname the policy accepts. */
export const MAX_CAPTURE_DOMAIN_CHARS = 253;

/**
 * Normalize a user-entered domain to a bare lowercase hostname. Accepts a pasted
 * URL (`https://www.example.com/x`), a bare host (`Example.com`), or a host with
 * a leading dot, and returns the hostname (`example.com` / `www.example.com`).
 * A single-label host (`intranet`, `localhost`) is not a public domain and is
 * refused. Returns `""` for input with no usable host so the caller can reject it.
 */
export function normalizeCaptureDomain(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/^\.+/, "");
  if (!trimmed) return "";
  let host: string;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
    host = url.hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return "";
  }
  if (!host || host.length > MAX_CAPTURE_DOMAIN_CHARS) return "";
  if (/^\d+(?:\.\d+){3}$/.test(host)) {
    return host.split(".").every((octet) => Number(octet) <= 255) ? host : "";
  }
  const labels = host.split(".");
  return labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
    ? host
    : "";
}

/** Whether a pause is in force at `now`; a lapsed deadline reads as resumed. */
export function pauseActive(pause: WebCapturePause | null, now: number): boolean {
  if (!pause) return false;
  return pause.until === null || pause.until > now;
}

/** Remaining pause time in ms for a timed pause, or `null` for an indefinite pause / when resumed. */
export function pauseRemainingMs(pause: WebCapturePause | null, now: number): number | null {
  if (!pause || pause.until === null || !pauseActive(pause, now)) return null;
  return Math.max(0, pause.until - now);
}

/** A segment's name and its stem before a file extension (`login.php` → `login`). */
function segmentNames(segment: string): string[] {
  const lower = segment.toLowerCase();
  const dot = lower.indexOf(".");
  return dot > 0 ? [lower, lower.slice(0, dot)] : [lower];
}

/**
 * Whether any path segment of `pathname` equals one of `segments`
 * (case-insensitive, after decoding), with or without a file extension or
 * matrix parameters: `/login`, `/%4Cogin`, `/login.php` and
 * `/login;jsessionid=x` all match `login`.
 */
export function pathHasSkippedSegment(pathname: string, segments: readonly string[]): boolean {
  if (segments.length === 0) return false;
  const wanted = new Set(segments.map((segment) => segment.toLowerCase()));
  return pathSegments(pathname).some((segment) =>
    segmentNames(segment).some((name) => wanted.has(name)),
  );
}

/**
 * Whether a path is refused by the segment rules, on a page at `host`: a
 * specific segment (`login`, `api-keys`, `mfa`) anywhere, a pair such as
 * `sessions/new`, and a generic word ({@link GENERIC_SKIP_SEGMENTS}) only
 * where an account page puts it.
 */
export function pathIsSkippedByRules(
  host: string,
  pathname: string,
  segments: readonly string[],
): boolean {
  const parts = pathSegments(pathname).map((segment) => segment.toLowerCase());
  const wanted = new Set(segments.map((segment) => segment.toLowerCase()));
  const reading =
    READING_HOST.test(comparableHost(host)) ||
    parts.some((part) => READING_SEGMENTS.has(part) || CODE_VIEW_SEGMENTS.has(part));
  return parts.some((part, index) => {
    if (index > 0 && SKIPPED_SEGMENT_PAIRS.some(([a, b]) => parts[index - 1] === a && part === b)) {
      return true;
    }
    return segmentNames(part).some((name) => {
      if (!wanted.has(name) && !GENERIC_SKIP_SEGMENTS.has(name)) return false;
      if (!GENERIC_SKIP_SEGMENTS.has(name)) return true;
      if (reading) return false;
      return index <= 1 || ACCOUNT_AREAS.has(parts[index - 1] ?? "");
    });
  });
}

/**
 * The paths a page is judged by: its own, and for a single-page app that
 * routes in the fragment (`/#/settings/tokens`, `/#!/settings/tokens`), the
 * routed path too.
 */
function judgedPaths(url: URL): string[] {
  const route = url.hash.startsWith("#/")
    ? url.hash.slice(1)
    : url.hash.startsWith("#!/")
      ? url.hash.slice(2)
      : null;
  if (route === null) return [url.pathname];
  try {
    return [url.pathname, new URL(route, url.origin).pathname];
  } catch {
    return [url.pathname];
  }
}

/** Whether a path falls under one of the built-in private message paths of `host`. */
function pageIsBuiltInSkip(host: string, paths: readonly string[]): boolean {
  return BUILT_IN_SKIP_PAGES.some(([domain, prefix]) => {
    if (!hostIsOwned(host, [domain])) return false;
    const wanted = pathSegments(prefix).map((segment) => segment.toLowerCase());
    return paths.some((path) => {
      const parts = pathSegments(path).map((segment) => segment.toLowerCase());
      return wanted.every((segment, index) => parts[index] === segment);
    });
  });
}

/** Whether the path, or a fragment-routed path, is one no browser captures. */
function pathIsSkipped(url: URL, host: string, policySegments: readonly string[]): boolean {
  const segments = [...DEFAULT_WEB_CAPTURE_RULES.skipPathSegments, ...policySegments];
  return judgedPaths(url).some(
    (path) => pathIsSecretLink(path) || pathIsSkippedByRules(host, path, segments),
  );
}

export type CaptureRefusal =
  | "invalid-url"
  | "gateway-host"
  | "own-site"
  | "excluded-domain"
  | "owned-domain"
  | "built-in-domain"
  | "skipped-path"
  | "paused"
  | "removed-page";

export type CaptureVerdict = { allowed: true } | { allowed: false; reason: CaptureRefusal };

/**
 * Judge one page URL against the policy. The gateway's own host is refused so
 * a browser never indexes the Omnesis portal into the corpus, and so are the
 * operator's own sites and the built-in mail, messaging and password-manager
 * sites. A path that names a sign-in, payment or credential flow, or carries a
 * token of its own, is refused whatever list the policy holds. `externalId` is
 * the page's content-plane id when the caller has computed it; without it the
 * removed-pages check is skipped.
 */
export function judgeCaptureUrl(
  policy: WebCapturePolicy,
  url: string,
  context: { gatewayHost: string; now: number; externalId?: string },
): CaptureVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "invalid-url" };
  }
  const host = comparableHost(parsed.hostname);
  if (hostIsOwned(host, [context.gatewayHost])) return { allowed: false, reason: "gateway-host" };
  if (hostIsOwned(host, policy.ownSites ?? [])) return { allowed: false, reason: "own-site" };
  if (hostIsOwned(host, policy.excludedDomains)) {
    return { allowed: false, reason: "excluded-domain" };
  }
  if (hostIsOwned(host, policy.ownedDomains)) return { allowed: false, reason: "owned-domain" };
  if (hostIsOwned(host, BUILT_IN_SKIP_DOMAINS) || pageIsBuiltInSkip(host, judgedPaths(parsed))) {
    return { allowed: false, reason: "built-in-domain" };
  }
  if (pathIsSkipped(parsed, host, policy.rules.skipPathSegments)) {
    return { allowed: false, reason: "skipped-path" };
  }
  if (pauseActive(policy.pause, context.now)) return { allowed: false, reason: "paused" };
  if (context.externalId !== undefined && policy.removedPages.includes(context.externalId)) {
    return { allowed: false, reason: "removed-page" };
  }
  return { allowed: true };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPause(value: unknown): value is WebCapturePause | null {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const until = (value as { until?: unknown }).until;
  return until === null || (typeof until === "number" && Number.isFinite(until));
}

export function isWebCaptureRules(value: unknown): value is WebCaptureRules {
  if (typeof value !== "object" || value === null) return false;
  const rules = value as Partial<WebCaptureRules>;
  return typeof rules.skipPasswordForms === "boolean" && isStringArray(rules.skipPathSegments);
}

/** Structural guard for a policy read off the wire or out of a cache. */
export function isWebCapturePolicy(value: unknown): value is WebCapturePolicy {
  if (typeof value !== "object" || value === null) return false;
  const policy = value as Partial<WebCapturePolicy>;
  return (
    typeof policy.updatedAt === "string" &&
    isPause(policy.pause) &&
    isStringArray(policy.excludedDomains) &&
    isStringArray(policy.ownedDomains) &&
    (policy.ownSites === undefined || isStringArray(policy.ownSites)) &&
    isWebCaptureRules(policy.rules) &&
    isStringArray(policy.removedPages) &&
    typeof policy.removedPagesTruncated === "boolean"
  );
}
