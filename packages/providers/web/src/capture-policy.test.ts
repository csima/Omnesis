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
    expect(pathIsSecretLink("/invite/Ab3dEfGh1jKlMnOp/accept")).toBe(true);
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
    "https://code.example/users/sign_in",
    "https://code.example/session/new",
    "https://code.example/sessions/new",
    "https://code.example/log_in",
    "https://code.example/settings//tokens",
    "https://cloud.example/console/keys",
    "https://cloud.example/dashboard/billing",
    "https://github.com/settings/tokens",
    "https://dashboard.stripe.com/apikeys",
    "https://platform.openai.com/api-keys",
    "https://console.anthropic.com/settings/keys",
  ])("refuses the credential path %s", (url) => {
    expect(judgeCaptureUrl(policy(), url, context)).toEqual({
      allowed: false,
      reason: "skipped-path",
    });
  });
  it.each([
    "https://en.wikipedia.org/wiki/Password",
    "https://docs.python.org/3/library/secrets.html",
    "https://redis.io/docs/latest/commands/keys/",
    "https://github.com/northstar-labs/ledger/blob/main/src/auth/session.ts",
    "https://docs.stripe.com/payments/checkout",
    "https://news.example.org/blog/register",
    "https://github.com/magic-research/very-long-repository-name-for-papers",
    "https://cdn.example.org/reset-css/a-modern-css-reset-for-every-project",
    "https://conf.example.org/invited-talks/building-reliable-systems-at-scale",
    "https://conf.example.org/invite/our-speakers-for-the-autumn-programme",
    "https://shop.example/products/password-notebook/reviews",
    "https://code.example/northstar/ledger/tree/main/docs/tokens",
  ])("lets the ordinary page %s through", (url) => {
    expect(judgeCaptureUrl(policy(), url, context)).toEqual({ allowed: true });
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
      "https://www.linkedin.com//messaging/",
      "https://www.facebook.com/messages;x=1/",
      "https://x.com/messages/123-456",
      "https://twitter.com/messages",
      "https://www.instagram.com/direct/inbox/",
      "https://www.reddit.com/message/inbox",
      "https://chat.reddit.com/room/abc",
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

/**
 * A path corpus from review: ordinary pages that name credential words, which
 * every browser must capture, and account pages that hold credentials, which
 * none may.
 */
const ORDINARY_PAGES = [
  "https://en.wikipedia.org/wiki/Password",
  "https://developer.mozilla.org/en-US/docs/Web/API/Credential_Management_API",
  "https://github.com/example-org/widget/blob/main/src/auth/session.ts",
  "https://github.com/example-org/widget/tree/main/packages/tokens",
  "https://github.com/example-org/widget/pulls",
  "https://github.com/example-org/auth",
  "https://github.com/example-org/keys-utils/issues/42",
  "https://www.npmjs.com/package/jsonwebtoken",
  "https://pypi.org/project/keyring/",
  "https://docs.python.org/3/library/secrets.html",
  "https://redis.io/commands/keys/",
  "https://kubernetes.io/docs/concepts/configuration/secret/",
  "https://stripe.com/docs/payments/checkout",
  "https://example-shop.com/blog/how-we-rebuilt-checkout",
  "https://news.example.com/2026/03/password-managers-compared",
  "https://www.example.com/articles/token-economics-explained",
  "https://medium.com/@jordan/understanding-oauth-scopes-1a2b3c4d5e6f",
  "https://stackoverflow.com/questions/12345678/how-to-hash-a-password-in-node",
  "https://stackoverflow.com/questions/12345678/jwt-token-expired-error",
  "https://www.reddit.com/r/selfhosted/comments/abc123/best_password_manager/",
  "https://example.com/products/keyboard-keys",
  "https://example.com/shop/keys",
  "https://example.com/register-office/locations",
  "https://example.com/events/register-for-the-marathon",
  "https://example.com/tokens/northcoin",
  "https://coinmarket.example.com/currencies/northcoin/tokens",
  "https://example.com/en/keys/master-key-system",
  "https://news.ycombinator.com/item?id=41234567",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://example.atlassian.net/wiki/spaces/ENG/pages/123/Auth+service+design",
  "https://example.atlassian.net/browse/ENG-1234",
  "https://gitlab.com/example-group/widget/-/merge_requests/17",
  "https://app.example.com/projects/42/billing-report",
  "https://example.com/careers/payments-engineer",
  "https://example.com/invite/team-offsite-2026",
  "https://example.com/verify/how-we-verify-sources",
  "https://example.com/confirm/booking-reference-ABC123",
  "https://huggingface.co/docs/hub/security-tokens",
  "https://example.com/research/payment-systems/overview",
  "https://example.com/docs/api/authentication",
  "https://example.com/u/maya/password-tips-for-families",
  "https://example.com/podcasts/secrets-of-the-deep",
  "https://example.com/podcast/episodes/secrets",
  "https://example.com/store/checkout-counter-displays",
  "https://shop.example.com/collections/gift-cards",
];

const CREDENTIAL_PAGES = [
  "https://vault.example.com/ui/vault/secrets/secret/kv/prod%2Fdb/details",
  "https://app.example.com/org/acme/project/web/secrets",
  "https://github.com/example-org/widget/settings/secrets/actions",
  "https://app.example.com/teams/acme/settings/billing",
  "https://github.com/settings/tokens",
  "https://github.com/settings/tokens/new",
  "https://github.com/settings/personal-access-tokens/new",
  "https://github.com/settings/keys",
  "https://github.com/login",
  "https://github.com/sessions/two-factor",
  "https://gitlab.com/-/user_settings/personal_access_tokens",
  "https://gitlab.com/-/profile/personal_access_tokens",
  "https://gitlab.com/-/user_settings/password/edit",
  "https://gitlab.com/users/sign_in",
  "https://dashboard.stripe.com/apikeys",
  "https://dashboard.stripe.com/test/apikeys",
  "https://dashboard.stripe.com/webhooks/we_1Abc",
  "https://platform.openai.com/api-keys",
  "https://platform.openai.com/settings/organization/api-keys",
  "https://console.anthropic.com/settings/keys",
  "https://console.cloud.google.com/apis/credentials",
  "https://console.aws.amazon.com/iam/home#/security_credentials",
  "https://us-east-1.console.aws.amazon.com/iam/home#/users/details/jordan?section=security_credentials",
  "https://app.netlify.com/user/applications#personal-access-tokens",
  "https://vercel.com/account/tokens",
  "https://app.slack.com/apps-manage/T00000000/integrations/profile/A000/tokens",
  "https://api.slack.com/apps/A0123456789/oauth",
  "https://huggingface.co/settings/tokens",
  "https://www.npmjs.com/settings/jordan/tokens",
  "https://pypi.org/manage/account/token/",
  "https://hub.docker.com/settings/security",
  "https://app.datadoghq.com/organization-settings/api-keys",
  "https://cloud.digitalocean.com/account/api/tokens",
  "https://dash.cloudflare.com/profile/api-tokens",
  "https://dash.cloudflare.com/0123abcd/api-tokens",
  "https://example.com/account/password",
  "https://example.com/account/billing",
  "https://example.com/settings/security/passwords",
  "https://example.com/reset/Q7rT2mX9pL4vN8kB3cZ6",
  "https://example.com/users/password/edit?reset_password_token=abc",
  "https://example.com/password/reset/Q7rT2mX9pL4vN8kB3cZ6",
  "https://example.com/verify-email/eyJhbGciOiJIUzI1NiJ9abc",
  "https://example.com/magic/Q7rT2mX9pL4vN8kB3cZ6",
  "https://example.com/auth/callback?code=abc&state=def",
  "https://example.com/en-us/account/payment-methods",
  "https://shop.example.com/checkout/7f3a9c1e2b4d",
  "https://example.com/cart/checkout",
  "https://app.example.com/workspace/jordan/settings/api",
  "https://app.example.com/org/acme/settings/tokens",
  "https://app.example.com/admin/integrations/secrets",
  "https://vault.example.com/ui/vault/secrets/kv/show/app",
  "https://example.com/u/jordan/settings/billing",
  "https://example.com/my-account/payment",
  "https://help.example.com/account/billing",
  "https://support.example.com/account/password",
  "https://example.com/docs/settings/tokens",
  "https://id.example.com/sso/saml",
  "https://accounts.example.com/signin/v2/identifier",
  "https://example.com/invite/AbCdEf0123456789XyZ",
  "https://example.com/invitations/accept/AbCdEf0123456789XyZ",
  "https://example.com/confirm-email/AbCdEf0123456789XyZ",
  "https://example.com/email/verify/AbCdEf0123456789XyZ",
  "https://example.com/r/AbCdEf0123456789XyZ",
];

describe("the path corpus", () => {
  const context = { gatewayHost: "omnesis.example.net", now: NOW };
  it.each(ORDINARY_PAGES)("captures the ordinary page %s", (url) => {
    expect(judgeCaptureUrl(policy(), url, context)).toEqual({ allowed: true });
  });
  it.each(CREDENTIAL_PAGES)("refuses the credential page %s", (url) => {
    expect(judgeCaptureUrl(policy(), url, context).allowed).toBe(false);
  });
});
