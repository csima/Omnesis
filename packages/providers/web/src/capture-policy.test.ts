// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  BUILT_IN_SKIP_DOMAINS,
  DEFAULT_WEB_CAPTURE_RULES,
  isWebCapturePolicy,
  judgeCaptureUrl,
  normalizeCaptureDomain,
  pathHasSkippedSegment,
  pathIsSecretLink,
  pauseActive,
  pauseRemainingMs,
  type WebCapturePolicy,
} from "./capture-policy.js";

const NOW = 1_800_000_000_000;

function policy(overrides: Partial<WebCapturePolicy> = {}): WebCapturePolicy {
  return {
    updatedAt: "",
    pause: null,
    excludedDomains: [],
    ownedDomains: [],
    rules: DEFAULT_WEB_CAPTURE_RULES,
    removedPages: [],
    removedPagesTruncated: false,
    ...overrides,
  };
}

describe("normalizeCaptureDomain", () => {
  it("accepts a pasted URL, a bare host and a leading dot", () => {
    expect(normalizeCaptureDomain("https://www.Example.com/path?x=1")).toBe("www.example.com");
    expect(normalizeCaptureDomain("  Example.COM  ")).toBe("example.com");
    expect(normalizeCaptureDomain(".example.com.")).toBe("example.com");
  });
  it("rejects input without a usable host", () => {
    expect(normalizeCaptureDomain("")).toBe("");
    expect(normalizeCaptureDomain("localhost")).toBe("");
    expect(normalizeCaptureDomain("not a host")).toBe("");
    expect(normalizeCaptureDomain(`${"a".repeat(64)}.example.com`)).toBe("");
  });
  it("keeps a valid IPv4 literal and drops an invalid one", () => {
    expect(normalizeCaptureDomain("192.0.2.10")).toBe("192.0.2.10");
    expect(normalizeCaptureDomain("192.0.2.999")).toBe("");
  });
});

describe("pause", () => {
  it("treats null and a lapsed deadline as resumed", () => {
    expect(pauseActive(null, NOW)).toBe(false);
    expect(pauseActive({ until: NOW - 1 }, NOW)).toBe(false);
    expect(pauseRemainingMs({ until: NOW - 1 }, NOW)).toBeNull();
  });
  it("reports an indefinite pause and a timed remainder", () => {
    expect(pauseActive({ until: null }, NOW)).toBe(true);
    expect(pauseRemainingMs({ until: null }, NOW)).toBeNull();
    expect(pauseRemainingMs({ until: NOW + 90_000 }, NOW)).toBe(90_000);
  });
});

describe("pathHasSkippedSegment", () => {
  it("matches whole segments only, case-insensitively, after decoding", () => {
    const segments = ["login", "checkout"];
    expect(pathHasSkippedSegment("/account/Login", segments)).toBe(true);
    expect(pathHasSkippedSegment("/shop/check%6fut/step-2", segments)).toBe(true);
    expect(pathHasSkippedSegment("/blog/login-tips-for-admins", segments)).toBe(false);
    expect(pathHasSkippedSegment("/", segments)).toBe(false);
    expect(pathHasSkippedSegment("/login", [])).toBe(false);
  });
  it("matches a segment with a file extension by its stem", () => {
    expect(pathHasSkippedSegment("/members/login.php", ["login"])).toBe(true);
    expect(pathHasSkippedSegment("/members/.login", ["login"])).toBe(false);
    expect(pathHasSkippedSegment("/members/logins.html", ["login"])).toBe(false);
  });
});

describe("pathIsSecretLink", () => {
  it("matches cdn-cgi/access paths on any host", () => {
    expect(pathIsSecretLink("/cdn-cgi/access/login/app.example.com")).toBe(true);
    expect(pathIsSecretLink("/cdn-cgi/access")).toBe(true);
    expect(pathIsSecretLink("/cdn-cgi/accessible")).toBe(false);
  });
  it("matches links that carry their own token, and not the bare keyword", () => {
    expect(pathIsSecretLink("/reset/Q2xhcmEgbm90IGEgdG9rZW4")).toBe(true);
    expect(pathIsSecretLink("/verify-email/3f9a1c7e5b2d4f6a8c0e")).toBe(true);
    expect(pathIsSecretLink("/invite/abcdefghijklmnop/accept")).toBe(true);
    expect(pathIsSecretLink("/magic-link/0123456789abcdef")).toBe(true);
    expect(pathIsSecretLink("/reset/short")).toBe(false);
    expect(pathIsSecretLink("/docs/how-to-reset")).toBe(false);
  });
});

describe("judgeCaptureUrl", () => {
  const context = { gatewayHost: "gateway.example.ts.net", now: NOW };

  it("allows an ordinary page under an empty policy", () => {
    expect(judgeCaptureUrl(policy(), "https://blog.example.org/post/1", context)).toEqual({
      allowed: true,
    });
  });
  it("refuses the gateway's own host and its subdomains", () => {
    expect(
      judgeCaptureUrl(policy(), "https://gateway.example.ts.net:7600/portal", context),
    ).toEqual({
      allowed: false,
      reason: "gateway-host",
    });
  });
  it("refuses excluded and owned domains, subdomains included", () => {
    const p = policy({ excludedDomains: ["bank.example"], ownedDomains: ["notes.example"] });
    expect(judgeCaptureUrl(p, "https://online.bank.example/x", context).allowed).toBe(false);
    expect(judgeCaptureUrl(p, "https://notes.example/page", context)).toEqual({
      allowed: false,
      reason: "owned-domain",
    });
    expect(judgeCaptureUrl(p, "https://evilbank.example/x", context).allowed).toBe(true);
  });
  it("refuses authentication and payment paths by the built-in rules", () => {
    expect(judgeCaptureUrl(policy(), "https://shop.example/checkout", context)).toEqual({
      allowed: false,
      reason: "skipped-path",
    });
    expect(judgeCaptureUrl(policy(), "https://shop.example/catalog", context).allowed).toBe(true);
  });
  it.each([
    "https://code.example/settings/tokens",
    "https://code.example/settings/personal-access-tokens/new",
    "https://cloud.example/account/api-keys",
    "https://cloud.example/account/api_keys",
    "https://cloud.example/auth/callback",
    "https://cloud.example/user/mfa",
    "https://cloud.example/settings/2fa",
    "https://cloud.example/oauth/authorize",
    "https://cloud.example/saml/acs",
    "https://cloud.example/vault/secrets/db",
    "https://cloud.example/members/login.php",
    "https://team.example/cdn-cgi/access/login/team.example",
    "https://app.example/reset/Zm9yZ290LXBhc3N3b3JkLXRva2Vu",
    "https://app.example/#/settings/tokens",
    "https://app.example/#!/settings/tokens",
    "https://cloud.example/%4Cogin",
    "https://cloud.example/login;jsessionid=abc",
    "https://cloud.example/settings/two-factor",
    "https://cloud.example/settings/api-tokens",
    "https://cloud.example/oauth2/token/",
    "https://code.example/settings/keys",
    "https://cloud.example/iam/security_credentials",
    "https://team.example/accept-invitation/Zm9yZ290LXBhc3N3b3Jk",
    "https://team.example/activate/Zm9yZ290LXBhc3N3b3Jk",
  ])("refuses the credential path %s", (url) => {
    expect(judgeCaptureUrl(policy(), url, context)).toEqual({
      allowed: false,
      reason: "skipped-path",
    });
  });
  it("applies the built-in path segments even when a gateway serves none", () => {
    const p = policy({ rules: { skipPasswordForms: true, skipPathSegments: [] } });
    expect(judgeCaptureUrl(p, "https://shop.example/checkout", context).allowed).toBe(false);
    const extra = policy({ rules: { skipPasswordForms: true, skipPathSegments: ["vault"] } });
    expect(judgeCaptureUrl(extra, "https://a.example/vault/item", context).allowed).toBe(false);
  });
  it("refuses the built-in mail, messaging and password-manager sites with no policy entry", () => {
    for (const domain of BUILT_IN_SKIP_DOMAINS) {
      expect(judgeCaptureUrl(policy(), `https://${domain}/inbox`, context), domain).toEqual({
        allowed: false,
        reason: "built-in-domain",
      });
    }
    expect(judgeCaptureUrl(policy(), "https://vault.bitwarden.com/", context).allowed).toBe(false);
    expect(judgeCaptureUrl(policy(), "https://notbitwarden.com/", context).allowed).toBe(true);
    for (const host of [
      "workspace.slack.com",
      "outlook.cloud.microsoft",
      "teams.live.com",
      "vault.bitwarden.eu",
      "my.1password.eu",
      "discordapp.com",
      "mail.google.com.",
    ]) {
      expect(judgeCaptureUrl(policy(), `https://${host}/x`, context), host).toEqual({
        allowed: false,
        reason: "built-in-domain",
      });
    }
  });
  it("refuses the built-in private message paths of public sites, and nothing else there", () => {
    for (const url of [
      "https://www.facebook.com/messages/t/123",
      "https://facebook.com/messages",
      "https://www.linkedin.com/messaging/thread/abc",
    ]) {
      expect(judgeCaptureUrl(policy(), url, context), url).toEqual({
        allowed: false,
        reason: "built-in-domain",
      });
    }
    expect(judgeCaptureUrl(policy(), "https://www.facebook.com/events", context).allowed).toBe(
      true,
    );
    expect(
      judgeCaptureUrl(policy(), "https://www.linkedin.com/messaging-tips", context).allowed,
    ).toBe(true);
  });
  it("refuses an owned or excluded host written with a trailing dot", () => {
    const p = policy({ excludedDomains: ["bank.example"], ownSites: ["agents.example.net"] });
    expect(judgeCaptureUrl(p, "https://online.bank.example./x", context).allowed).toBe(false);
    expect(judgeCaptureUrl(p, "https://agents.example.net./x", context)).toEqual({
      allowed: false,
      reason: "own-site",
    });
  });
  it("refuses the operator's own sites and their subdomains", () => {
    const p = policy({ ownSites: ["agents.example.net", "apps.example.net"] });
    expect(judgeCaptureUrl(p, "https://agents.example.net/browser", context)).toEqual({
      allowed: false,
      reason: "own-site",
    });
    expect(judgeCaptureUrl(p, "https://notes-app.apps.example.net/", context)).toEqual({
      allowed: false,
      reason: "own-site",
    });
    expect(judgeCaptureUrl(p, "https://example.net/", context).allowed).toBe(true);
    expect(judgeCaptureUrl(policy(), "https://agents.example.net/", context).allowed).toBe(true);
  });
  it("refuses everything while paused, and nothing once the pause lapsed", () => {
    expect(
      judgeCaptureUrl(policy({ pause: { until: null } }), "https://a.example/", context),
    ).toEqual({ allowed: false, reason: "paused" });
    expect(
      judgeCaptureUrl(policy({ pause: { until: NOW - 1 } }), "https://a.example/", context).allowed,
    ).toBe(true);
  });
  it("refuses a page the user removed for good when its id is known", () => {
    const p = policy({ removedPages: ["abc"] });
    expect(judgeCaptureUrl(p, "https://a.example/", { ...context, externalId: "abc" })).toEqual({
      allowed: false,
      reason: "removed-page",
    });
    expect(judgeCaptureUrl(p, "https://a.example/", context).allowed).toBe(true);
  });
  it("refuses an unparseable URL", () => {
    expect(judgeCaptureUrl(policy(), "not a url", context)).toEqual({
      allowed: false,
      reason: "invalid-url",
    });
  });
});

describe("isWebCapturePolicy", () => {
  it("accepts the wire shape and rejects a malformed one", () => {
    expect(isWebCapturePolicy(policy())).toBe(true);
    expect(isWebCapturePolicy(policy({ pause: { until: null } }))).toBe(true);
    expect(isWebCapturePolicy({ ...policy(), excludedDomains: [1] })).toBe(false);
    expect(isWebCapturePolicy({ ...policy(), rules: {} })).toBe(false);
    expect(isWebCapturePolicy({ ...policy(), pause: { until: "soon" } })).toBe(false);
    expect(isWebCapturePolicy(null)).toBe(false);
  });
  it("accepts a policy without own sites from an older gateway, and rejects a malformed list", () => {
    expect(isWebCapturePolicy(policy({ ownSites: ["agents.example.net"] }))).toBe(true);
    const older: Partial<WebCapturePolicy> = policy();
    delete older.ownSites;
    expect(isWebCapturePolicy(older)).toBe(true);
    expect(isWebCapturePolicy({ ...policy(), ownSites: "agents.example.net" })).toBe(false);
  });
});
