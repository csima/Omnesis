"use strict";
(() => {
  // ../packages/core/src/url-normalize.ts
  function hostIsOwned(host, ownedDomains) {
    const h = host.trim().toLowerCase().replace(/\.+$/, "");
    if (!h) return false;
    for (const raw of ownedDomains) {
      const d = raw.trim().toLowerCase().replace(/\.+$/, "");
      if (!d) continue;
      if (h === d || h.endsWith("." + d)) return true;
    }
    return false;
  }

  // ../packages/providers/web/src/capture-policy.ts
  var DEFAULT_WEB_CAPTURE_RULES = {
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
      "personal_access_tokens",
      "api-keys",
      "apikeys",
      "api_keys",
      "checkout",
      "payment",
      "payments",
      "billing"
    ]
  };
  var GENERIC_SKIP_SEGMENTS = /* @__PURE__ */ new Set([
    "auth",
    "password",
    "passwords",
    "secrets",
    "credentials",
    "payment",
    "payments",
    "payment-methods",
    "payment_methods",
    "billing",
    "checkout",
    "register"
  ]);
  var ACCOUNT_SKIP_SEGMENTS = /* @__PURE__ */ new Set([
    "keys",
    "token",
    "tokens",
    "security",
    "api",
    "access",
    "webhooks"
  ]);
  var ACCOUNT_AREAS = /* @__PURE__ */ new Set([
    "settings",
    "account",
    "accounts",
    "my-account",
    "console",
    "dashboard",
    "admin",
    "user",
    "user_settings",
    "profile",
    "preferences",
    "manage"
  ]);
  var ACCOUNT_HOST = /^(?:app|dashboard|console|admin|my|manage|account|accounts|portal)\./;
  var SECRET_STORE_PARENTS = /* @__PURE__ */ new Set(["ui", "vault", "admin", "integrations", "settings"]);
  var CODE_HOST = /^(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|gitlab\.[a-z0-9.-]+)$/;
  var CODE_VIEW_SEGMENTS = /* @__PURE__ */ new Set(["blob", "tree", "raw"]);
  var READING_SEGMENTS = /* @__PURE__ */ new Set([
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
    "faq"
  ]);
  var READING_HOST = /^(?:docs?|developers?|wiki|learn|help|support|blog)\.|(?:^|\.)wikipedia\.org$/;
  var SKIPPED_SEGMENT_PAIRS = [
    ["session", "new"],
    ["sessions", "new"]
  ];
  var BUILT_IN_SKIP_DOMAINS = [
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
    "chat.reddit.com"
  ];
  var BUILT_IN_SKIP_PAGES = [
    ["facebook.com", "/messages"],
    ["linkedin.com", "/messaging"],
    ["x.com", "/messages"],
    ["twitter.com", "/messages"],
    ["instagram.com", "/direct"],
    ["reddit.com", "/message"]
  ];
  var TOKEN_LINK_KEYWORD = /^(?:reset|verify|invite|magic|activate|confirm|accept|accept-invitation|r)(?:[-_](?:password|email|account|link|invite|invitation))?$/;
  function segmentLooksLikeToken(segment) {
    if (segment.length < 16 || !/^[A-Za-z0-9_\-=.~]+$/.test(segment)) return false;
    if (/[A-Za-z]{2,}[-_][A-Za-z0-9]{2,}/.test(segment) && /[A-Za-z]{3,}[-_]/.test(segment)) {
      return false;
    }
    const digits = /[0-9]/.test(segment);
    const letters = /[A-Za-z]/.test(segment);
    return digits && letters || /[a-z]/.test(segment) && /[A-Z]/.test(segment);
  }
  function pathSegments(pathname) {
    return pathname.split("/").map((raw) => {
      let segment = raw;
      try {
        segment = decodeURIComponent(segment);
      } catch {
      }
      return segment.split(";")[0];
    }).filter(Boolean);
  }
  function pathIsSecretLink(pathname) {
    const segments = pathSegments(pathname);
    return segments.some((segment, index) => {
      const lower = segment.toLowerCase();
      if (lower === "cdn-cgi" && segments[index + 1]?.toLowerCase().split(".")[0] === "access") {
        return true;
      }
      const next = segments[index + 1];
      return TOKEN_LINK_KEYWORD.test(lower) && next !== void 0 && segmentLooksLikeToken(next);
    });
  }
  function comparableHost(host) {
    return host.trim().toLowerCase().replace(/\.+$/, "");
  }
  var MAX_CAPTURE_DOMAIN_CHARS = 253;
  function pauseActive(pause, now) {
    if (!pause) return false;
    return pause.until === null || pause.until > now;
  }
  function segmentNames(segment) {
    const lower = segment.toLowerCase();
    const dot = lower.indexOf(".");
    return dot > 0 ? [lower, lower.slice(0, dot)] : [lower];
  }
  function pathIsSkippedByRules(host, pathname, segments) {
    const comparable = comparableHost(host);
    const parts = pathSegments(pathname).map((segment) => segment.toLowerCase());
    const specific = new Set(
      segments.map((segment) => segment.toLowerCase()).filter((name) => !GENERIC_SKIP_SEGMENTS.has(name) && !ACCOUNT_SKIP_SEGMENTS.has(name))
    );
    const codeHost = CODE_HOST.test(comparable);
    const accountHost = ACCOUNT_HOST.test(comparable);
    const firstAccountArea = parts.findIndex((part) => ACCOUNT_AREAS.has(part));
    const codeView = parts.some(
      (part, index) => CODE_VIEW_SEGMENTS.has(part) && (codeHost || parts[index - 1] === "-" || index >= 2)
    );
    const reading = READING_HOST.test(comparable) || parts.some((part) => READING_SEGMENTS.has(part));
    const exempt = firstAccountArea < 0 && (codeView || reading);
    return parts.some((part, index) => {
      if (index > 0 && SKIPPED_SEGMENT_PAIRS.some(([a, b]) => parts[index - 1] === a && part === b)) {
        return true;
      }
      if (part === "secrets" && index > 0 && SECRET_STORE_PARENTS.has(parts[index - 1])) return true;
      return segmentNames(part).some((name) => {
        if (specific.has(name)) return true;
        const generic = GENERIC_SKIP_SEGMENTS.has(name);
        if (!generic && !ACCOUNT_SKIP_SEGMENTS.has(name)) return false;
        if (exempt) return false;
        const belowAccount = firstAccountArea >= 0 && firstAccountArea < index;
        if (belowAccount || accountHost) return true;
        return generic && index <= 1 && !codeHost;
      });
    });
  }
  function extrasNameCredentialPage(url, segments) {
    const specific = new Set(
      segments.map((segment) => segment.toLowerCase()).filter((name) => !GENERIC_SKIP_SEGMENTS.has(name) && !ACCOUNT_SKIP_SEGMENTS.has(name))
    );
    const values = [];
    for (const target of judgedUrls(url)) {
      for (const value of target.searchParams.values()) values.push(value);
      if (target.hash && !/^#!?\//.test(target.hash)) values.push(target.hash.slice(1));
    }
    return values.some((value) => specific.has(value.trim().toLowerCase()));
  }
  function judgedUrls(url) {
    const route = url.hash.startsWith("#/") ? url.hash.slice(1) : url.hash.startsWith("#!/") ? url.hash.slice(2) : null;
    if (route === null) return [url];
    try {
      return [url, new URL(route, url.origin)];
    } catch {
      return [url];
    }
  }
  function judgedPaths(url) {
    return judgedUrls(url).map((target) => target.pathname);
  }
  function pageIsBuiltInSkip(host, paths) {
    return BUILT_IN_SKIP_PAGES.some(([domain, prefix]) => {
      if (!hostIsOwned(host, [domain])) return false;
      const wanted = pathSegments(prefix).map((segment) => segment.toLowerCase());
      return paths.some((path) => {
        const parts = pathSegments(path).map((segment) => segment.toLowerCase());
        return wanted.every((segment, index) => parts[index] === segment);
      });
    });
  }
  function pathIsSkipped(url, host, policySegments) {
    const segments = [...DEFAULT_WEB_CAPTURE_RULES.skipPathSegments, ...policySegments];
    return judgedPaths(url).some(
      (path) => pathIsSecretLink(path) || pathIsSkippedByRules(host, path, segments)
    ) || extrasNameCredentialPage(url, segments);
  }
  function judgeCaptureUrl(policy, url, context) {
    let parsed;
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
    if (context.externalId !== void 0 && policy.removedPages.includes(context.externalId)) {
      return { allowed: false, reason: "removed-page" };
    }
    return { allowed: true };
  }
  function isStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
  }
  function isScreenshots(value) {
    if (value === void 0) return true;
    if (typeof value !== "object" || value === null) return false;
    const screenshots = value;
    return typeof screenshots.enabled === "boolean" && (screenshots.available === void 0 || screenshots.available === false);
  }
  function isPause(value) {
    if (value === null) return true;
    if (typeof value !== "object") return false;
    const until = value.until;
    return until === null || typeof until === "number" && Number.isFinite(until);
  }
  function isWebCaptureRules(value) {
    if (typeof value !== "object" || value === null) return false;
    const rules = value;
    return typeof rules.skipPasswordForms === "boolean" && isStringArray(rules.skipPathSegments);
  }
  function isWebCapturePolicy(value) {
    if (typeof value !== "object" || value === null) return false;
    const policy = value;
    return typeof policy.updatedAt === "string" && isPause(policy.pause) && isStringArray(policy.excludedDomains) && isStringArray(policy.ownedDomains) && (policy.ownSites === void 0 || isStringArray(policy.ownSites)) && isWebCaptureRules(policy.rules) && isStringArray(policy.removedPages) && typeof policy.removedPagesTruncated === "boolean" && isScreenshots(policy.screenshots);
  }

  // src/capture/content-hash.ts
  async function hashText(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // src/capture/policy.ts
  var CAPTURE_POLICY_KEY = "omnesis.capture.policy.v1";
  var CAPTURE_POLICY_TTL_MS = 15 * 60 * 1e3;
  var PAUSE_ONE_HOUR_MS = 60 * 60 * 1e3;
  var PAUSE_ONE_DAY_MS = 24 * 60 * 60 * 1e3;
  async function readCachedPolicy(store) {
    const raw = await store.get(CAPTURE_POLICY_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || !isWebCapturePolicy(parsed.policy) || typeof parsed.fetchedAt !== "number" || !Number.isFinite(parsed.fetchedAt)) {
        return null;
      }
      return { policy: parsed.policy, fetchedAt: parsed.fetchedAt };
    } catch {
      return null;
    }
  }
  async function writeCachedPolicy(store, policy, fetchedAt) {
    await store.set(CAPTURE_POLICY_KEY, JSON.stringify({ policy, fetchedAt }));
  }
  async function clearCachedPolicy(store) {
    await store.set(CAPTURE_POLICY_KEY, "");
  }
  function policyIsStale(cached, now) {
    return now - cached.fetchedAt >= CAPTURE_POLICY_TTL_MS || cached.fetchedAt > now;
  }

  // src/capture/lifecycle.ts
  var MAX_CAPTURE_URL_CHARS = 8192;
  var MAX_CAPTURE_TITLE_CHARS = 1e4;

  // src/chrome/capture-permission-state.ts
  var CAPTURE_PERMISSION_STATE_KEY = "omnesis.capture.hostPermission.v1";

  // src/chrome/messages.ts
  var CAPTURE_HANDOFF_FAILURE_KEY = "omnesis.capture.handoffFailure.v1";
  var CAPTURE_PENDING_PREFIX = "omnesis.capture.pending.v1.";
  function isStoredCaptureHandoff(value) {
    if (typeof value !== "object" || value === null) return false;
    const record = value;
    return typeof record.at === "number" && Number.isFinite(record.at) && typeof record.order === "string" && record.order.length > 0 && record.order.length <= 160 && isPairingId(record.pairingId) && isCaptureEmission(record.emission);
  }
  function isCaptureEmission(value) {
    if (typeof value !== "object" || value === null) return false;
    const emission = value;
    if (emission.kind !== "visit" && emission.kind !== "re-extract" || typeof emission.normalizedUrl !== "string" || emission.normalizedUrl.length > MAX_CAPTURE_URL_CHARS || typeof emission.title !== "string" || emission.title.length > MAX_CAPTURE_TITLE_CHARS || typeof emission.text !== "string" || emission.text.length > 25e4 || typeof emission.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(emission.contentHash) || typeof emission.visitedAt !== "string" || !Number.isFinite(Date.parse(emission.visitedAt)) || typeof emission.dwellMs !== "number" || !Number.isFinite(emission.dwellMs) || emission.dwellMs < 0 || typeof emission.contentChanged !== "boolean") {
      return false;
    }
    try {
      const url = new URL(emission.normalizedUrl);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }
  function isCaptureMessage(value) {
    if (typeof value !== "object" || value === null) return false;
    const message = value;
    return message.type === "capture" && isCaptureEmission(message.emission) && typeof message.handoffKey === "string" && message.handoffKey.startsWith(CAPTURE_PENDING_PREFIX) && message.handoffKey.length <= 256 && isPairingId(message.pairingId);
  }
  function isPairingId(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  }

  // src/chrome/handoff-storage.ts
  function capturePairingId(config) {
    return hashText(`${config.gatewayUrl.replace(/\/+$/, "")}\0${config.deviceId}`);
  }
  async function pendingHandoffKeys(storage) {
    return (await storage.getKeys()).filter((key) => key.startsWith(CAPTURE_PENDING_PREFIX));
  }
  async function readPendingHandoffs(storage) {
    const keys = await pendingHandoffKeys(storage);
    if (keys.length === 0) return [];
    const raw = await storage.get(keys);
    return keys.map((key) => {
      try {
        const parsed = JSON.parse(String(raw[key]));
        return { key, record: isStoredCaptureHandoff(parsed) ? parsed : null };
      } catch {
        return { key, record: null };
      }
    }).sort((a, b) => (a.record?.at ?? 0) - (b.record?.at ?? 0));
  }
  async function clearPendingHandoffs(storage) {
    const keys = await pendingHandoffKeys(storage);
    if (keys.length > 0) await storage.remove(keys);
  }

  // src/push/response-body.ts
  var MAX_GATEWAY_RESPONSE_BYTES = 1024 * 1024;
  var MAX_GATEWAY_REASON_CHARS = 512;
  async function readBoundedResponseText(response2, maximumBytes = MAX_GATEWAY_RESPONSE_BYTES) {
    const declared = Number(response2.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximumBytes) throw tooLarge();
    const reader = response2.body?.getReader();
    if (!reader) {
      const text2 = await response2.text();
      if (new TextEncoder().encode(text2).byteLength > maximumBytes) throw tooLarge();
      return text2;
    }
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maximumBytes) {
          await reader.cancel();
          throw tooLarge();
        }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  function boundedGatewayReason(reason) {
    return reason.slice(0, MAX_GATEWAY_REASON_CHARS);
  }
  function tooLarge() {
    return new Error("Gateway response exceeded the extension size limit");
  }

  // src/push/pairing.ts
  var GatewayUrlError = class extends Error {
    constructor(message) {
      super(boundedGatewayReason(message));
      this.name = "GatewayUrlError";
    }
  };
  function normalizeGatewayUrl(input) {
    const trimmed = input.trim();
    if (!trimmed) throw new GatewayUrlError("Enter the gateway URL.");
    let url;
    try {
      url = new URL(trimmed);
    } catch {
      throw new GatewayUrlError(
        "That doesn't look like a URL. Use the gateway's HTTPS hostname, e.g. https://gateway.example.ts.net:7600"
      );
    }
    if (url.protocol !== "https:") {
      throw new GatewayUrlError("The gateway URL must use https://.");
    }
    if (url.username || url.password) {
      throw new GatewayUrlError("The gateway URL must not contain a username or password.");
    }
    if (isIpLiteral(url.hostname)) {
      throw new GatewayUrlError(
        "Use the gateway's trusted hostname (its Tailscale / mkcert certificate name), not an IP address — the certificate covers the name, not the IP."
      );
    }
    const port = url.port ? `:${url.port}` : "";
    return `${url.protocol}//${url.hostname}${port}`;
  }
  function isIpLiteral(host) {
    const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
    if (h.includes(":") && /^[0-9a-f:]+$/i.test(h)) return true;
    return false;
  }
  var REQUIRED_WEB_SCOPE = "write:web";

  // src/chrome/pairing-record.ts
  var PAIRING_KEY = "omnesis.pairing.v1";
  var MAX_GATEWAY_VERSION_CHARS = 64;
  function isBrowserPairing(value) {
    if (typeof value !== "object" || value === null) return false;
    const pairing = value;
    if (typeof pairing.gatewayUrl !== "string" || !Array.isArray(pairing.scopes) || !pairing.scopes.every((scope) => typeof scope === "string") || typeof pairing.deviceId !== "string" || typeof pairing.pairedAt !== "number" || !Number.isFinite(pairing.pairedAt) || pairing.gatewayVersion !== void 0 && (typeof pairing.gatewayVersion !== "string" || pairing.gatewayVersion.length > MAX_GATEWAY_VERSION_CHARS)) {
      return false;
    }
    try {
      return normalizeGatewayUrl(pairing.gatewayUrl) === pairing.gatewayUrl;
    } catch {
      return false;
    }
  }
  function parsePairing(raw) {
    if (typeof raw !== "string") return null;
    try {
      const parsed = JSON.parse(raw);
      return isBrowserPairing(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  // src/push/bounded-request.ts
  async function boundedRequest(fetch, input, init, timeoutMs) {
    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response2 = await withTimeout(
        fetch(input, { ...init, signal: controller.signal }),
        timeoutMs
      );
      const body = await withTimeout(
        readBoundedResponseText(response2),
        Math.max(1, deadline - Date.now())
      );
      return {
        status: response2.status,
        headers: response2.headers,
        text: () => Promise.resolve(body)
      };
    } finally {
      clearTimeout(timer);
    }
  }
  function withTimeout(work, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("gateway request timed out")), timeoutMs);
      void work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  // src/push/capture-policy.ts
  var CapturePolicyError = class extends Error {
    constructor(status, reason) {
      super(reason);
      this.status = status;
      this.name = "CapturePolicyError";
    }
    status;
  };
  var CapturePolicyClient = class {
    constructor(gatewayUrl, token, fetch, timeoutMs = 4e3) {
      this.token = token;
      this.fetch = fetch;
      this.timeoutMs = timeoutMs;
      this.base = normalizeGatewayUrl(gatewayUrl);
    }
    token;
    fetch;
    timeoutMs;
    base;
    read() {
      return this.policyRequest("GET", "/web-capture-policy");
    }
    async addExcludedDomain(domain, purge) {
      const body = await this.jsonRequest("POST", "/web-capture-policy/excluded-domains", {
        domain,
        purge
      });
      const result = body;
      if (!isWebCapturePolicy(result.policy) || typeof result.purged !== "number") {
        throw new CapturePolicyError(200, "The gateway returned an unreadable capture policy");
      }
      return { policy: result.policy, purged: result.purged };
    }
    removeExcludedDomain(domain) {
      return this.policyRequest(
        "DELETE",
        `/web-capture-policy/excluded-domains/${encodeURIComponent(domain)}`
      );
    }
    setPause(until) {
      return this.policyRequest("PUT", "/web-capture-policy/pause", { until });
    }
    clearPause() {
      return this.policyRequest("DELETE", "/web-capture-policy/pause");
    }
    /** Switch page screenshots on or off for every paired browser. */
    setScreenshots(enabled) {
      return this.policyRequest("PUT", "/web-capture-policy/screenshots", { enabled });
    }
    async policyRequest(method, path, body) {
      const parsed = await this.jsonRequest(method, path, body);
      if (!isWebCapturePolicy(parsed)) {
        throw new CapturePolicyError(200, "The gateway returned an unreadable capture policy");
      }
      return parsed;
    }
    async jsonRequest(method, path, body) {
      const response2 = await boundedRequest(
        this.fetch,
        `${this.base}${path}`,
        {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.token}`,
            ...body === void 0 ? {} : { "content-type": "application/json" }
          },
          body: body === void 0 ? "" : JSON.stringify(body),
          redirect: "error"
        },
        this.timeoutMs
      );
      const text = await response2.text();
      if (response2.status < 200 || response2.status >= 300) {
        let reason = `HTTP ${response2.status}`;
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed.error === "string" && parsed.error) {
            reason = boundedGatewayReason(parsed.error);
          }
        } catch {
        }
        throw new CapturePolicyError(response2.status, reason);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new CapturePolicyError(
          response2.status,
          "The gateway returned an unreadable capture policy"
        );
      }
    }
  };

  // src/push/queue.ts
  var QUEUE_STORAGE_KEY = "omnesis.push.queue.v1";
  var QUEUE_CORRUPTION_KEY = "omnesis.push.queueCorruption.v1";
  var QUEUE_OVERFLOW_KEY = "omnesis.push.queueOverflow.v1";
  var DEFAULT_MAX_ITEMS = 1e3;
  var DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
  var PersistentQueue = class {
    constructor(store, key = QUEUE_STORAGE_KEY, limits = {
      maxItems: DEFAULT_MAX_ITEMS,
      maxBytes: DEFAULT_MAX_BYTES
    }) {
      this.store = store;
      this.key = key;
      this.limits = limits;
    }
    store;
    key;
    limits;
    items = [];
    loaded = false;
    /** Re-read the durable snapshot into memory. Idempotent; cheap to repeat. */
    async load() {
      const raw = await this.store.get(this.key);
      if (!raw) {
        this.items = [];
        this.loaded = true;
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        await this.recoverCorruptSnapshot([], null);
        return;
      }
      if (!Array.isArray(parsed)) {
        await this.recoverCorruptSnapshot([], null);
        return;
      }
      const valid = parsed.filter(isQueueItem);
      if (valid.length !== parsed.length) {
        await this.recoverCorruptSnapshot(valid, parsed.length - valid.length);
        return;
      }
      this.items = valid;
      this.loaded = true;
      if (this.exceedsLimits()) await this.persist();
    }
    async recoverCorruptSnapshot(items, discarded) {
      this.items = items;
      this.loaded = true;
      await this.persist();
      await this.store.set(
        QUEUE_CORRUPTION_KEY,
        JSON.stringify({ at: Date.now(), discarded })
      );
    }
    async ensureLoaded() {
      if (!this.loaded) await this.load();
    }
    async persist() {
      let discardedDocuments = 0;
      let discardedVisits = 0;
      const sizes = this.items.map((item) => (JSON.stringify(item).length + 1) * 2);
      let totalBytes = 2 + sizes.reduce((sum, size) => sum + size, 0);
      let remainingItems = this.items.length;
      const discard = /* @__PURE__ */ new Set();
      for (const kind of ["preview", "visit", "document"]) {
        for (let index = 0; index < this.items.length; index += 1) {
          if (remainingItems <= this.limits.maxItems && totalBytes <= this.limits.maxBytes || this.items[index].kind !== kind) {
            continue;
          }
          discard.add(index);
          remainingItems -= 1;
          totalBytes -= sizes[index];
          if (kind === "document") discardedDocuments += 1;
          else if (kind === "visit") discardedVisits += 1;
        }
      }
      if (discard.size > 0) this.items = this.items.filter((_, index) => !discard.has(index));
      await this.store.set(this.key, JSON.stringify(this.items));
      if (discardedDocuments > 0 || discardedVisits > 0) {
        let previous;
        try {
          const raw = await this.store.get(QUEUE_OVERFLOW_KEY);
          const parsed = raw ? JSON.parse(raw) : null;
          previous = isQueueOverflow(parsed) ? parsed : null;
        } catch {
          previous = null;
        }
        await this.store.set(
          QUEUE_OVERFLOW_KEY,
          JSON.stringify({
            at: Date.now(),
            discardedDocuments: (previous?.discardedDocuments ?? 0) + discardedDocuments,
            discardedVisits: (previous?.discardedVisits ?? 0) + discardedVisits
          })
        );
      }
    }
    exceedsLimits() {
      return this.items.length > this.limits.maxItems || JSON.stringify(this.items).length * 2 > this.limits.maxBytes;
    }
    /** Current queue depth (reads the durable snapshot). */
    async size() {
      const raw = await this.store.get(this.key);
      if (!raw) return 0;
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(isQueueItem).length : 0;
      } catch {
        return 0;
      }
    }
    /** Snapshot copy of the queued items, FIFO order. */
    async list() {
      await this.ensureLoaded();
      return [...this.items];
    }
    /**
     * Append an item and flush to storage. De-duplicates on `item.id` so a
     * crash-during-drain that re-enqueues an in-flight item can't double it.
     */
    async enqueue(item) {
      await this.ensureLoaded();
      if (this.items.some((q) => q.id === item.id)) return;
      this.items.push(item);
      await this.persist();
    }
    /**
     * Append `item` while removing older queued snapshots it supersedes. This is
     * used for page documents: only the newest body for one external page needs
     * to survive a long outage, while visits remain distinct analytics events.
     */
    async enqueueReplacing(item, supersedes, follows) {
      await this.ensureLoaded();
      if (this.items.some((queued) => queued.id === item.id)) return;
      const kept = this.items.filter((queued) => !supersedes(queued));
      const trailing = follows ? kept.filter(follows) : [];
      this.items = [...kept.filter((queued) => !trailing.includes(queued)), item, ...trailing];
      await this.persist();
    }
    /**
     * Replace the queue with exactly `items` and flush. Used by the drain loop
     * to commit progress after each bounded delivery attempt.
     */
    async replaceAll(items) {
      this.items = [...items];
      this.loaded = true;
      await this.persist();
    }
    /** Drop every item (test helper / "clear queue" affordance). */
    async clear() {
      this.items = [];
      this.loaded = true;
      await this.persist();
    }
  };
  function isQueueItem(value) {
    if (typeof value !== "object" || value === null) return false;
    const item = value;
    if (typeof item.id !== "string" || typeof item.attempts !== "number" || !Number.isFinite(item.attempts) || typeof item.notBefore !== "number" || !Number.isFinite(item.notBefore) || typeof item.enqueuedAt !== "number" || !Number.isFinite(item.enqueuedAt)) {
      return false;
    }
    return item.kind === "document" && typeof item.doc === "object" && item.doc !== null || item.kind === "visit" && typeof item.visit === "object" && item.visit !== null || item.kind === "preview" && isPreviewUpload(item.preview);
  }
  function isPreviewUpload(value) {
    if (typeof value !== "object" || value === null) return false;
    const preview = value;
    return ["providerId", "sourceId", "externalId", "contentHash", "capturedAt", "image"].every(
      (key) => typeof preview[key] === "string"
    ) && (preview.contentType === "image/webp" || preview.contentType === "image/jpeg") && typeof preview.width === "number" && typeof preview.height === "number";
  }
  function isQueueOverflow(value) {
    if (typeof value !== "object" || value === null) return false;
    const overflow = value;
    return isFiniteNonNegativeInteger(overflow.at) && isFiniteNonNegativeInteger(overflow.discardedDocuments) && isFiniteNonNegativeInteger(overflow.discardedVisits);
  }
  function isFiniteNonNegativeInteger(value) {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
  }

  // src/push/observability.ts
  var PUSH_HEALTH_KEY = "omnesis.push.health.v1";
  var PUSH_SERVER_STATE_KEY = "omnesis.push.serverState.v1";
  var PUSH_RECENT_KEY = "omnesis.push.recent.v1";
  var PUSH_CONNECTIVITY_KEY = "omnesis.push.connectivity.v1";
  var PUSH_CHECKED_KEY = "omnesis.push.checked.v1";
  var PUSH_FAILURE_KEY = "omnesis.push.failure.v1";
  var PUSH_RETRY_KEY = "omnesis.push.retry.v1";
  var RECENT_CAP = 50;
  var storeWriteLanes = /* @__PURE__ */ new WeakMap();
  var PushObservability = class {
    constructor(store, sessionId = "", generation = 0) {
      this.store = store;
      this.sessionId = sessionId;
      this.generation = generation;
    }
    store;
    sessionId;
    generation;
    getHealth() {
      return this.readValidated(PUSH_HEALTH_KEY, isPushHealth);
    }
    writeHealth(health) {
      return this.writeSnapshot(PUSH_HEALTH_KEY, health);
    }
    getFailure() {
      return this.readValidated(PUSH_FAILURE_KEY, isPushFailure);
    }
    async writeFailure(failure) {
      await serializeStoreWrite(this.store, async () => {
        const previous = await this.getFailure();
        const sameFailure = previous?.kind === failure.kind && previous.status === failure.status && previous.reason === failure.reason;
        await this.store.set(
          PUSH_FAILURE_KEY,
          JSON.stringify({ ...failure, count: (sameFailure ? previous.count : 0) + 1 })
        );
      });
    }
    getRetry() {
      return this.readValidated(PUSH_RETRY_KEY, isPushRetry);
    }
    writeRetry(retry) {
      return this.writeSnapshot(PUSH_RETRY_KEY, retry);
    }
    clearRetry() {
      return serializeStoreWrite(this.store, () => this.store.set(PUSH_RETRY_KEY, ""));
    }
    getQueueCorruption() {
      return this.readValidated(QUEUE_CORRUPTION_KEY, isQueueCorruption);
    }
    getQueueOverflow() {
      return this.readValidated(QUEUE_OVERFLOW_KEY, isQueueOverflow2);
    }
    getServerState() {
      return this.readValidated(PUSH_SERVER_STATE_KEY, isPushServerState);
    }
    writeServerState(state) {
      return this.writeSnapshot(PUSH_SERVER_STATE_KEY, state);
    }
    clearServerState() {
      return serializeStoreWrite(this.store, () => this.store.set(PUSH_SERVER_STATE_KEY, ""));
    }
    async getRecentDeliveries() {
      const raw = await this.store.get(PUSH_RECENT_KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter(isRecentDelivery);
      } catch {
      }
      return [];
    }
    async prependRecent(deliveries) {
      if (deliveries.length === 0) return;
      await serializeStoreWrite(this.store, async () => {
        const prior = await this.getRecentDeliveries();
        await this.store.set(
          PUSH_RECENT_KEY,
          JSON.stringify([...deliveries, ...prior].slice(0, RECENT_CAP))
        );
      });
    }
    getConnectivity() {
      return this.readValidated(PUSH_CONNECTIVITY_KEY, isConnectivity);
    }
    writeConnectivity(connectivity) {
      return this.writeSnapshot(PUSH_CONNECTIVITY_KEY, connectivity);
    }
    async getLastCheckedAt() {
      const raw = await this.store.get(PUSH_CHECKED_KEY);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return isFiniteTimestamp(parsed.at) ? parsed.at : null;
      } catch {
        return null;
      }
    }
    async writeChecked(at) {
      await serializeStoreWrite(this.store, async () => {
        const raw = await this.store.get(PUSH_CHECKED_KEY);
        if (raw) {
          try {
            if (snapshotIsNewer(raw, at, this.sessionId, this.generation)) return;
          } catch {
          }
        }
        await this.store.set(
          PUSH_CHECKED_KEY,
          JSON.stringify({ at, sessionId: this.sessionId, generation: this.generation })
        );
      });
    }
    async writeSnapshot(key, value) {
      await serializeStoreWrite(this.store, async () => {
        const raw = await this.store.get(key);
        if (raw) {
          try {
            if (snapshotIsNewer(raw, value.at, this.sessionId, this.generation)) return;
          } catch {
          }
        }
        await this.store.set(
          key,
          JSON.stringify({ ...value, sessionId: this.sessionId, generation: this.generation })
        );
      });
    }
    async readValidated(key, guard) {
      const raw = await this.store.get(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return guard(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  };
  function serializeStoreWrite(store, work) {
    const previous = storeWriteLanes.get(store) ?? Promise.resolve();
    const result = previous.then(work, work);
    storeWriteLanes.set(
      store,
      result.then(
        () => void 0,
        () => void 0
      )
    );
    return result;
  }
  function snapshotIsNewer(raw, at, sessionId, generation) {
    const previous = JSON.parse(raw);
    const previousGeneration = isFiniteNonNegativeInteger2(previous.generation) ? previous.generation : 0;
    const sameSession = previous.sessionId === sessionId && sessionId.length > 0;
    return sameSession && previousGeneration > generation || (!sameSession || previousGeneration === generation) && isFiniteTimestamp(previous.at) && previous.at > at;
  }
  async function clearPushServerState(store) {
    await store.set(PUSH_SERVER_STATE_KEY, "");
  }
  async function clearPushObservability(store) {
    await store.set(PUSH_RECENT_KEY, "");
    await store.set(PUSH_CONNECTIVITY_KEY, "");
    await store.set(PUSH_CHECKED_KEY, "");
    await store.set(PUSH_RETRY_KEY, "");
    await clearPushDataLoss(store);
  }
  async function clearPushDataLoss(store) {
    await store.set(PUSH_FAILURE_KEY, "");
    await store.set(QUEUE_CORRUPTION_KEY, "");
    await store.set(QUEUE_OVERFLOW_KEY, "");
  }
  async function clearPushHealth(store) {
    await store.set(PUSH_HEALTH_KEY, "");
    await store.set(PUSH_CONNECTIVITY_KEY, "");
    await store.set(PUSH_CHECKED_KEY, "");
  }
  function isFiniteTimestamp(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }
  function isFiniteNonNegativeInteger2(value) {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
  }
  function isPushHealth(value) {
    if (typeof value !== "object" || value === null) return false;
    const item = value;
    return typeof item.ok === "boolean" && isFiniteTimestamp(item.at) && (item.reason === void 0 || typeof item.reason === "string");
  }
  function isPushFailure(value) {
    if (typeof value !== "object" || value === null) return false;
    const item = value;
    return typeof item.reason === "string" && typeof item.status === "number" && (item.kind === "document" || item.kind === "visit") && isFiniteTimestamp(item.at) && isFiniteNonNegativeInteger2(item.count);
  }
  function isPushRetry(value) {
    if (typeof value !== "object" || value === null) return false;
    const item = value;
    return typeof item.itemId === "string" && (item.kind === "document" || item.kind === "visit") && (item.status === void 0 || typeof item.status === "number") && typeof item.reason === "string" && isFiniteNonNegativeInteger2(item.attempts) && isFiniteTimestamp(item.nextRetryAt) && isFiniteTimestamp(item.at);
  }
  function isPushServerState(value) {
    if (typeof value !== "object" || value === null) return false;
    const item = value;
    return (item.state === "paused" || item.state === "removed") && typeof item.reason === "string" && isFiniteTimestamp(item.at);
  }
  function isRecentDelivery(value) {
    if (typeof value !== "object" || value === null) return false;
    const item = value;
    return item.kind === "document" && typeof item.title === "string" && typeof item.url === "string" && isFiniteTimestamp(item.at);
  }
  function isConnectivity(value) {
    if (typeof value !== "object" || value === null) return false;
    const item = value;
    return typeof item.reachable === "boolean" && (item.degraded === void 0 || typeof item.degraded === "boolean") && (item.reason === void 0 || typeof item.reason === "string") && isFiniteTimestamp(item.at);
  }
  function isQueueCorruption(value) {
    if (typeof value !== "object" || value === null) return false;
    const item = value;
    return isFiniteTimestamp(item.at) && (item.discarded === null || isFiniteNonNegativeInteger2(item.discarded));
  }
  function isQueueOverflow2(value) {
    if (typeof value !== "object" || value === null) return false;
    const item = value;
    return isFiniteTimestamp(item.at) && isFiniteNonNegativeInteger2(item.discardedDocuments) && isFiniteNonNegativeInteger2(item.discardedVisits);
  }

  // src/push/types.ts
  var DEFAULT_BACKOFF = {
    baseMs: 1e3,
    maxMs: 5 * 60 * 1e3,
    factor: 2,
    maxAttempts: 12
  };

  // src/push/delivery-response.ts
  function networkReason(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 120);
  }
  async function responseReason(response2) {
    try {
      const parsed = JSON.parse(await response2.text());
      if (typeof parsed.error === "string" && parsed.error) return boundedGatewayReason(parsed.error);
    } catch {
    }
    return `HTTP ${response2.status}`;
  }
  async function parseSuccessfulDelivery(response2, kind, externalId) {
    let parsed;
    try {
      parsed = JSON.parse(await response2.text());
    } catch {
      return invalidSuccess(response2.status);
    }
    if (typeof parsed !== "object" || parsed === null) return invalidSuccess(response2.status);
    const body = parsed;
    if (body.rejected !== void 0) {
      if (!Array.isArray(body.rejected) || body.rejected.length === 0) {
        return invalidSuccess(response2.status);
      }
      const first = body.rejected[0];
      if (first?.reason === "paused" || first?.reason === "removed") {
        return { kind: "rejected", state: first.reason, reason: first.reason };
      }
      if (typeof first?.reason === "string" && first.reason) {
        return {
          kind: "drop",
          reason: boundedGatewayReason(`Rejected by the gateway: ${first.reason}`),
          status: response2.status
        };
      }
      return invalidSuccess(response2.status);
    }
    const ingestedOk = isFiniteNonNegativeInteger3(body.ingested);
    const deletedOk = kind === "document" || isFiniteNonNegativeInteger3(body.deleted);
    if (!ingestedOk || !deletedOk) return invalidSuccess(response2.status);
    if (externalId !== void 0 && Array.isArray(body.suppressed) && body.suppressed.includes(externalId)) {
      return { kind: "suppressed" };
    }
    return { kind: "ok" };
  }
  async function parseEmptyDocumentProbe(response2) {
    try {
      const parsed = JSON.parse(await response2.text());
      if (typeof parsed !== "object" || parsed === null) return false;
      const body = parsed;
      return body.ingested === 0 && body.rejected === void 0;
    } catch {
      return false;
    }
  }
  function invalidSuccess(status) {
    return { kind: "retry", status, reason: "Invalid gateway success response" };
  }
  function isFiniteNonNegativeInteger3(value) {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
  }

  // src/push/documents.ts
  var WEB_PROVIDER_ID = "web";
  var WEB_SOURCE_ID = "web";
  var PAGE_VISITS_SCHEMA = {
    tableName: "page_visits",
    displayName: "Page Visits",
    description: "Web pages viewed in the browser, captured on focused dwell",
    columns: [
      {
        name: "url",
        type: "VARCHAR",
        description: "Normalized page URL (fragment dropped, tracking params stripped)",
        references: "url"
      },
      { name: "domain", type: "VARCHAR", description: "Host of the page (e.g. example.com)" },
      { name: "title", type: "VARCHAR", description: "Page title at capture time", nullable: true },
      { name: "visited_at", type: "TIMESTAMPTZ", description: "When the dwell was confirmed" },
      {
        name: "dwell_ms",
        type: "INTEGER",
        description: "Focused dwell time on the page, in milliseconds"
      },
      {
        name: "browser_device_id",
        type: "VARCHAR",
        description: "Paired-device ID reported by the extension for Chrome profile attribution",
        nullable: true
      },
      {
        name: "browser_profile_label",
        type: "VARCHAR",
        description: "User-entered Chrome profile name at capture time",
        nullable: true
      }
    ],
    primaryKey: ["url", "visited_at"],
    semanticTimeColumn: "visited_at",
    record: {
      titleColumns: ["title", "url"],
      keyColumns: ["url", "visited_at"]
    },
    exampleQueries: [
      "SELECT domain, COUNT(*) AS visits FROM page_visits WHERE visited_at >= CURRENT_DATE - INTERVAL '7 days' GROUP BY domain ORDER BY visits DESC LIMIT 10",
      "SELECT domain, SUM(dwell_ms)/60000.0 AS minutes FROM page_visits GROUP BY domain ORDER BY minutes DESC LIMIT 10",
      "SELECT url, title, browser_profile_label, visited_at, dwell_ms FROM page_visits ORDER BY visited_at DESC LIMIT 25"
    ]
  };
  async function buildWebPageDocument(capture) {
    const host = safeHost(capture.normalizedUrl);
    const externalId = await hashText(capture.normalizedUrl);
    return {
      providerId: WEB_PROVIDER_ID,
      sourceId: WEB_SOURCE_ID,
      externalId,
      title: capture.title || capture.normalizedUrl,
      content: capture.text,
      contentHash: capture.contentHash,
      metadata: {
        documentType: "webpage",
        sourceUrl: capture.normalizedUrl,
        ...host ? { tags: [host] } : {},
        ...capture.browserProfile ? {
          extra: {
            browserDeviceId: capture.browserProfile.deviceId,
            browserProfileLabel: capture.browserProfile.label
          }
        } : {}
      },
      sourceCreatedAt: capture.visitedAt,
      sourceUpdatedAt: capture.visitedAt
    };
  }
  function buildPageVisit(capture) {
    return {
      url: capture.normalizedUrl,
      domain: safeHost(capture.normalizedUrl) ?? "",
      title: capture.title || null,
      visited_at: capture.visitedAt,
      dwell_ms: Math.max(0, Math.round(capture.dwellMs)),
      ...capture.browserProfile ? {
        browser_device_id: capture.browserProfile.deviceId,
        browser_profile_label: capture.browserProfile.label
      } : {}
    };
  }
  function safeHost(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }

  // src/push/transport.ts
  var CLIENT_VERSION_PARAM = "clientVersion";
  var PushTransport = class {
    constructor(gatewayUrl, token, fetch, timeoutMs, clientVersion) {
      this.token = token;
      this.fetch = fetch;
      this.timeoutMs = timeoutMs;
      const normalized = normalizeGatewayUrl(gatewayUrl);
      if (normalized !== gatewayUrl) {
        throw new Error("Gateway URL must be its canonical HTTPS origin.");
      }
      this.base = normalized;
      this.query = clientVersion ? `?${new URLSearchParams({ [CLIENT_VERSION_PARAM]: clientVersion }).toString()}` : "";
    }
    token;
    fetch;
    timeoutMs;
    base;
    query;
    /** The URL of a gateway route, carrying this build's version when known. */
    url(path) {
      return `${this.base}${path}${this.query}`;
    }
    probeEmptyDocuments() {
      return this.request(this.url("/documents"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`
        },
        body: JSON.stringify({ documents: [] }),
        redirect: "error"
      });
    }
    /** Deliver one queue item and classify every transport/gateway outcome. */
    async deliver(item) {
      if (item.kind === "preview") return this.deliverPreview(item);
      const { path, body } = item.kind === "document" ? { path: "/documents", body: { documents: [item.doc] } } : {
        path: "/analytics/ingest",
        body: {
          tableName: "page_visits",
          sourceId: WEB_SOURCE_ID,
          records: [item.visit],
          // Re-sending the schema is idempotent and creates the DuckDB
          // table on the first visit ingest.
          schema: PAGE_VISITS_SCHEMA
        }
      };
      let response2;
      try {
        response2 = await this.request(this.url(path), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`
          },
          body: JSON.stringify(body),
          redirect: "error"
        });
      } catch (error) {
        return { kind: "retry", network: true, reason: networkReason(error) };
      }
      if (response2.status >= 200 && response2.status < 300) {
        return parseSuccessfulDelivery(
          response2,
          item.kind,
          item.kind === "document" ? item.doc.externalId : void 0
        );
      }
      if ([404, 405, 408, 409, 425, 429, 503].includes(response2.status)) {
        return {
          kind: "retry",
          status: response2.status,
          reason: await responseReason(response2),
          retryAfterMs: parseRetryAfter(response2.headers.get("retry-after"))
        };
      }
      if (response2.status >= 500) {
        return {
          kind: "retry",
          status: response2.status,
          reason: await responseReason(response2)
        };
      }
      let reason = `HTTP ${response2.status}`;
      try {
        const parsed = JSON.parse(await response2.text());
        if (parsed?.error) reason = boundedGatewayReason(parsed.error);
      } catch {
      }
      return { kind: "drop", reason, status: response2.status };
    }
    /**
     * Upload one page screenshot. A refusal is final for this shot — screenshots
     * switched off, the page excluded, paused or deleted since, the page not
     * stored, an image the gateway does not take — and the shot leaves the
     * queue silently as `suppressed`. A missing or revoked credential is kept
     * for re-pair like any upload, and congestion holds the queue back like any
     * upload; a server error retries this shot alone, a few times, so a gateway
     * that cannot store previews never stops pages syncing.
     */
    async deliverPreview(item) {
      const { contentHash: _contentHash, ...body } = item.preview;
      let response2;
      try {
        response2 = await this.request(this.url("/documents/preview"), {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`
          },
          body: JSON.stringify(body),
          redirect: "error"
        });
      } catch (error) {
        return { kind: "retry", network: true, reason: networkReason(error) };
      }
      if (response2.status >= 200 && response2.status < 300) {
        try {
          const parsed = JSON.parse(await response2.text());
          if (parsed?.stored === true) return { kind: "ok" };
        } catch {
        }
        return {
          kind: "retry",
          status: response2.status,
          reason: "Invalid gateway success response",
          itemOnly: true
        };
      }
      if (response2.status === 401 || response2.status === 403) {
        return { kind: "drop", reason: await responseReason(response2), status: response2.status };
      }
      if ([408, 425, 429].includes(response2.status)) {
        return {
          kind: "retry",
          status: response2.status,
          reason: await responseReason(response2),
          retryAfterMs: parseRetryAfter(response2.headers.get("retry-after"))
        };
      }
      if (response2.status >= 500) {
        return {
          kind: "retry",
          status: response2.status,
          reason: await responseReason(response2),
          retryAfterMs: parseRetryAfter(response2.headers.get("retry-after")),
          itemOnly: true
        };
      }
      return { kind: "suppressed" };
    }
    request(input, init) {
      return boundedRequest(this.fetch, input, init, this.timeoutMs);
    }
  };
  function parseRetryAfter(value) {
    if (!value) return void 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1e3);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    return void 0;
  }

  // src/push/client.ts
  var PROBE_INTERVAL_MS = 5 * 60 * 1e3;
  var PREVIEW_LEDGER_KEY = "omnesis.push.previewLedger.v1";
  var MAX_PREVIEW_ATTEMPTS = 3;
  var PREVIEW_LEDGER_LIMIT = 2e3;
  var PushClient = class {
    queue;
    backoff;
    now;
    batchSize;
    observability;
    transport;
    store;
    constructor(config) {
      this.store = config.store;
      this.queue = new PersistentQueue(config.store);
      this.backoff = { ...DEFAULT_BACKOFF, ...config.backoff };
      this.now = config.now ?? Date.now;
      this.batchSize = config.batchSize ?? 5;
      this.transport = new PushTransport(
        config.gatewayUrl,
        config.token,
        config.fetch,
        config.requestTimeoutMs ?? 4e3,
        config.clientVersion
      );
      this.observability = new PushObservability(
        config.store,
        config.observationSessionId,
        config.observationGeneration
      );
    }
    /** Current queue depth — surfaced in the popup. */
    queueDepth() {
      return this.queue.size();
    }
    /** Make retained captures immediately eligible after a successful re-pair. */
    async resetBackoff() {
      await this.queue.load();
      const items = await this.queue.list();
      await this.queue.replaceAll(items.map((item) => ({ ...item, attempts: 0, notBefore: 0 })));
    }
    /**
     * Enqueue a content-plane document (`web-page`). The doc's `externalId` is
     * derived from the normalized URL, so re-pushing the same page upserts gateway-side. A
     * newer queued snapshot replaces an older snapshot for that external ID;
     * only the latest body/title needs to survive an outage.
     */
    async enqueueDocument(doc) {
      const id = `doc:${doc.externalId}:${doc.contentHash}:${doc.title}`;
      const item = {
        kind: "document",
        id,
        doc,
        attempts: 0,
        notBefore: 0,
        enqueuedAt: this.now()
      };
      await this.queue.enqueueReplacing(
        item,
        (queued) => queued.kind === "document" && queued.doc.externalId === doc.externalId,
        // A page's screenshot is uploaded only once the page itself is in.
        (queued) => queued.kind === "preview" && queued.preview.externalId === doc.externalId
      );
    }
    /**
     * Whether a screenshot of this page at this text is still wanted: not when
     * the last one uploaded, or one already queued, was taken of the same text.
     */
    async previewWanted(externalId, contentHash) {
      if ((await this.readPreviewLedger())[externalId] === contentHash) return false;
      const queued = await this.queue.list();
      return !queued.some(
        (item) => item.kind === "preview" && item.preview.externalId === externalId && item.preview.contentHash === contentHash
      );
    }
    /**
     * Enqueue a page screenshot. It is delivered after any queued document for
     * the same page, and replaces an older queued screenshot of that page.
     */
    async enqueuePreview(preview) {
      const item = {
        kind: "preview",
        id: `preview:${preview.externalId}:${preview.contentHash}`,
        preview,
        attempts: 0,
        notBefore: 0,
        enqueuedAt: this.now()
      };
      await this.queue.enqueueReplacing(
        item,
        (queued) => queued.kind === "preview" && queued.preview.externalId === preview.externalId
      );
    }
    async readPreviewLedger() {
      try {
        const raw = await this.store.get(PREVIEW_LEDGER_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
        return Object.fromEntries(
          Object.entries(parsed).filter(
            (entry) => typeof entry[1] === "string"
          )
        );
      } catch {
        return {};
      }
    }
    async recordUploadedPreview(externalId, contentHash) {
      const ledger = await this.readPreviewLedger();
      delete ledger[externalId];
      ledger[externalId] = contentHash;
      const entries = Object.entries(ledger);
      await this.store.set(
        PREVIEW_LEDGER_KEY,
        JSON.stringify(Object.fromEntries(entries.slice(-PREVIEW_LEDGER_LIMIT)))
      );
    }
    /**
     * Enqueue an analytics-plane `page_visits` row. Each dwell-confirmed visit
     * is a distinct event (PK `(url, visited_at)`), so the in-queue `id` keys on
     * both — two visits to the same URL produce two rows.
     */
    async enqueueVisit(visit) {
      const id = `visit:${visit.url}:${visit.visited_at}`;
      const item = {
        kind: "visit",
        id,
        visit,
        attempts: 0,
        notBefore: 0,
        enqueuedAt: this.now()
      };
      await this.queue.enqueue(item);
    }
    /**
     * Deliver every currently-eligible queued item, oldest first. Items whose
     * `notBefore` is in the future are skipped (still backing off). Returns a
     * summary plus the soonest-eligible timestamp so the caller can schedule the
     * next wake-up via `chrome.alarms`.
     *
     * Progress is committed after each request, so an interrupted drain resumes
     * from the first unaccounted item on the next wake. The gateway endpoints are
     * idempotent, which also makes a crash between acceptance and the local
     * commit safe to replay.
     */
    async drain() {
      await this.queue.load();
      const all = await this.queue.list();
      const now = this.now();
      const ready = all.filter((i) => i.notBefore <= now);
      const eligible = ready.slice(0, this.batchSize);
      const unprocessed = ready.slice(this.batchSize);
      const deferred = all.filter((i) => i.notBefore > now);
      let delivered = 0;
      let dropped = 0;
      let suppressed = 0;
      const retained = [];
      let docDelivered = false;
      let authReject = null;
      const permanentFailures = [];
      let retryFailure = null;
      const attemptedNonRetryIds = /* @__PURE__ */ new Set();
      let serverReject = null;
      let serverRejectReason = "";
      const recentBatch = [];
      let networkFailed = false;
      let gatewayResponded = false;
      let networkReasonStr;
      for (let index = 0; index < eligible.length; index += 1) {
        const item = eligible[index];
        const outcome = await this.transport.deliver(item);
        if (outcome.kind !== "retry") attemptedNonRetryIds.add(item.id);
        if (outcome.kind !== "retry" || !outcome.network) gatewayResponded = true;
        let stopNotBefore = null;
        if (outcome.kind === "ok") {
          delivered += 1;
          if (item.kind === "document") {
            docDelivered = true;
            recentBatch.push(recentFromItem(item, now));
          } else if (item.kind === "preview") {
            await this.recordUploadedPreview(item.preview.externalId, item.preview.contentHash);
          }
        } else if (outcome.kind === "suppressed") {
          suppressed += 1;
        } else if (outcome.kind === "rejected") {
          serverReject = outcome.state;
          serverRejectReason = outcome.reason;
          retained.push({ ...item, notBefore: now + PROBE_INTERVAL_MS });
          stopNotBefore = now + PROBE_INTERVAL_MS;
        } else if (outcome.kind === "drop") {
          if (outcome.status === 401 || outcome.status === 403) {
            authReject = outcome.reason;
            retained.push({ ...item, notBefore: now + PROBE_INTERVAL_MS });
            stopNotBefore = now + PROBE_INTERVAL_MS;
          } else {
            dropped += 1;
            permanentFailures.push({
              reason: outcome.reason,
              status: outcome.status,
              kind: item.kind,
              at: now
            });
          }
        } else if (outcome.kind === "retry" && outcome.itemOnly) {
          const attempts = item.attempts + 1;
          if (attempts >= MAX_PREVIEW_ATTEMPTS) {
            suppressed += 1;
          } else {
            retained.push({
              ...item,
              attempts,
              notBefore: now + this.computeDelay(attempts, outcome.retryAfterMs)
            });
          }
        } else {
          if (outcome.network) {
            networkFailed = true;
            if (networkReasonStr === void 0) networkReasonStr = outcome.reason;
          }
          const attempts = item.attempts + 1;
          const boundedAttempts = Math.min(attempts, this.backoff.maxAttempts);
          const nextRetryAt = now + this.computeDelay(boundedAttempts, outcome.retryAfterMs);
          retained.push({
            ...item,
            attempts: boundedAttempts,
            notBefore: nextRetryAt
          });
          retryFailure = {
            itemId: item.id,
            kind: item.kind,
            ...outcome.status === void 0 ? {} : { status: outcome.status },
            reason: outcome.reason ?? (outcome.status ? `HTTP ${outcome.status}` : "delivery failed"),
            attempts: boundedAttempts,
            nextRetryAt,
            at: now
          };
          stopNotBefore = nextRetryAt;
        }
        const untouched = eligible.slice(index + 1);
        if (stopNotBefore !== null) {
          retained.push(...untouched.map((queued) => ({ ...queued, notBefore: stopNotBefore })));
        }
        await this.queue.replaceAll([
          ...retained,
          ...stopNotBefore !== null ? [] : untouched,
          ...stopNotBefore !== null ? unprocessed.map((queued) => ({ ...queued, notBefore: stopNotBefore })) : unprocessed,
          ...deferred
        ]);
        if (stopNotBefore !== null) break;
      }
      const remaining = await this.queue.list();
      if (authReject !== null) {
        await this.observability.writeHealth({ ok: false, reason: authReject, at: now });
      } else if (docDelivered) {
        await this.observability.writeHealth({ ok: true, at: now });
      }
      for (const failure of permanentFailures) await this.observability.writeFailure(failure);
      if (serverReject !== null) {
        await this.observability.clearRetry();
      } else if (retryFailure) {
        await this.observability.writeRetry(retryFailure);
      } else {
        const previousRetry = await this.getRetry();
        if (previousRetry && (!remaining.some((item) => item.id === previousRetry.itemId) || attemptedNonRetryIds.has(previousRetry.itemId))) {
          await this.observability.clearRetry();
        }
      }
      if (serverReject !== null) {
        await this.observability.writeServerState({
          state: serverReject,
          reason: serverRejectReason,
          at: now
        });
      } else if (delivered > 0) {
        await this.clearServerState();
      }
      await this.observability.prependRecent(recentBatch.reverse());
      if (delivered > 0 || gatewayResponded) {
        await this.observability.writeConnectivity({ reachable: true, at: now });
      } else if (networkFailed && eligible.length > 0) {
        await this.observability.writeConnectivity({
          reachable: false,
          reason: networkReasonStr,
          at: now
        });
      }
      return {
        delivered,
        retained: remaining.length,
        dropped,
        suppressed,
        nextEligibleAt: remaining.length ? Math.min(...remaining.map((i) => i.notBefore)) : null
      };
    }
    /** Backoff interval for a given attempt count, honouring an explicit Retry-After. */
    computeDelay(attempts, retryAfterMs) {
      if (retryAfterMs !== void 0 && retryAfterMs >= 0) {
        return Math.min(Math.max(retryAfterMs, this.backoff.baseMs), this.backoff.maxMs);
      }
      const exp = this.backoff.baseMs * Math.pow(this.backoff.factor, attempts - 1);
      return Math.min(exp, this.backoff.maxMs);
    }
    getHealth() {
      return this.observability.getHealth();
    }
    getFailure() {
      return this.observability.getFailure();
    }
    getRetry() {
      return this.observability.getRetry();
    }
    getQueueCorruption() {
      return this.observability.getQueueCorruption();
    }
    getQueueOverflow() {
      return this.observability.getQueueOverflow();
    }
    getServerState() {
      return this.observability.getServerState();
    }
    clearServerState() {
      return this.observability.clearServerState();
    }
    getRecentDeliveries() {
      return this.observability.getRecentDeliveries();
    }
    getConnectivity() {
      return this.observability.getConnectivity();
    }
    getLastCheckedAt() {
      return this.observability.getLastCheckedAt();
    }
    /**
     * Proactively verify the token + gateway, independently of the queue.
     *
     * Posts an **empty** document batch (`{ documents: [] }`) with the stored
     * bearer token. That request writes nothing but traverses the exact auth path
     * a real push does, so its status is an authoritative liveness verdict:
     *   - `2xx` — the gateway authenticated this empty request and stamps the
     *     liveness beacon. It does not clear a page-upload error: an empty batch
     *     does not prove that a real source-scoped document can be written.
     *   - `401/403` — the token is revoked/deleted/unscoped (e.g. the device was
     *     removed in the portal). Written to the SAME push-health snapshot a
     *     rejected-document drain uses, so the toolbar badge turns red and the
     *     popup shows the "re-pair this browser" warning — the one action the user
     *     must take — even with an empty queue.
     *   - transport failure — a connectivity fact, not an auth verdict: records
     *     the gateway offline and leaves the auth-health snapshot untouched (a
     *     transient outage must never masquerade as a revoked token).
     *
     * The scope specificity of `write:web` is covered separately (pair-time
     * validation + the popup's `scopeOk` check), so an empty batch — which skips
     * the per-source scope enforcement — is the right shape here: it isolates the
     * one thing the passive model missed, token *validity*, from scope.
     *
     * Deliberately does NOT touch the removed/paused server-state snapshot: an
     * empty batch carries no source to be rejected, so it can neither set nor
     * clear that condition (only a real delivery can).
     */
    async probeAuth() {
      const now = this.now();
      let res;
      try {
        res = await this.transport.probeEmptyDocuments();
      } catch (err) {
        const reason2 = networkReason(err);
        await this.observability.writeConnectivity({ reachable: false, reason: reason2, at: now });
        return { reachable: false, auth: "unknown", reason: reason2 };
      }
      await this.observability.writeConnectivity({ reachable: true, at: now });
      if (res.status >= 200 && res.status < 300) {
        if (await parseEmptyDocumentProbe(res)) {
          await this.observability.writeChecked(now);
          return { reachable: true, auth: "ok" };
        }
        const reason2 = "Invalid gateway liveness response";
        await this.observability.writeConnectivity({
          reachable: true,
          degraded: true,
          reason: reason2,
          at: now
        });
        return { reachable: true, auth: "unknown", reason: reason2 };
      }
      if (res.status === 401 || res.status === 403) {
        let reason2 = `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(await res.text());
          if (parsed?.error) reason2 = boundedGatewayReason(parsed.error);
        } catch {
        }
        await this.observability.writeHealth({ ok: false, reason: reason2, at: now });
        await this.observability.writeChecked(now);
        return { reachable: true, auth: "failed", reason: reason2 };
      }
      const reason = `HTTP ${res.status}`;
      await this.observability.writeConnectivity({
        reachable: true,
        degraded: true,
        reason,
        at: now
      });
      return { reachable: true, auth: "unknown", reason };
    }
    /**
     * Run {@link probeAuth} only if the last check is older than `maxAgeMs`,
     * returning `null` when skipped. The service worker calls this on an idle
     * drain pass so a paired-but-quiet extension still re-validates its token on a
     * bounded cadence, without probing on every one-minute tick.
     */
    async probeAuthIfStale(maxAgeMs) {
      const at = await this.getLastCheckedAt();
      if (at !== null && this.now() - at < maxAgeMs) return null;
      return this.probeAuth();
    }
  };
  function recentFromItem(item, at) {
    const url = item.doc.metadata?.sourceUrl ?? item.doc.externalId;
    return { title: item.doc.title ?? "", url, kind: "document", at };
  }
  async function clearPushQueue(store) {
    await new PersistentQueue(store).clear();
    await store.set(PREVIEW_LEDGER_KEY, "");
  }

  // src/safari/native-contract.ts
  var FIXED_REQUESTS = /* @__PURE__ */ new Set([
    "POST /documents",
    "POST /analytics/ingest",
    "GET /web-capture-policy",
    "PUT /web-capture-policy/pause",
    "DELETE /web-capture-policy/pause",
    "POST /web-capture-policy/excluded-domains"
  ]);
  var EXCLUDED_DOMAIN_PREFIX = "/web-capture-policy/excluded-domains/";
  var DOMAIN_SEGMENT = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
  var MAX_DOMAIN_SEGMENT_CHARS = 253;
  function isAllowedNativeRequest(method, path) {
    if (FIXED_REQUESTS.has(`${method} ${path}`)) return true;
    if (method !== "DELETE" || !path.startsWith(EXCLUDED_DOMAIN_PREFIX)) return false;
    const domain = path.slice(EXCLUDED_DOMAIN_PREFIX.length);
    return domain.length <= MAX_DOMAIN_SEGMENT_CHARS && DOMAIN_SEGMENT.test(domain);
  }

  // src/safari/native-bridge.ts
  var SAFARI_GATEWAY_ORIGIN = "https://gateway.omnesis.invalid";
  var NATIVE_MESSAGE_TIMEOUT_MS = 2e4;
  var MAX_DEVICE_ID_CHARS = 128;
  var MAX_GATEWAY_HOST_CHARS = 255;
  function parseNativeStatus(raw) {
    if (typeof raw !== "object" || raw === null) return null;
    const status = raw;
    if (status.paired === false) return { paired: false };
    if (status.paired !== true || typeof status.deviceId !== "string" || status.deviceId.length === 0 || status.deviceId.length > MAX_DEVICE_ID_CHARS || typeof status.gatewayHost !== "string" || status.gatewayHost.length === 0 || status.gatewayHost.length > MAX_GATEWAY_HOST_CHARS) {
      return null;
    }
    return { paired: true, deviceId: status.deviceId, gatewayHost: status.gatewayHost };
  }
  function parseNativeResponse(raw) {
    if (typeof raw !== "object" || raw === null) return null;
    const response2 = raw;
    if (response2.ok === false) {
      return response2.reason === "unpaired" || response2.reason === "refused" || response2.reason === "network" ? { ok: false, reason: response2.reason } : null;
    }
    if (response2.ok !== true || typeof response2.status !== "number" || !Number.isInteger(response2.status) || response2.status < 100 || response2.status > 599 || typeof response2.body !== "string") {
      return null;
    }
    return {
      ok: true,
      status: response2.status,
      body: response2.body,
      ...typeof response2.retryAfter === "string" ? { retryAfter: response2.retryAfter } : {}
    };
  }
  function withDeadline(work, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      const fail = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", fail);
        reject(new TypeError("The Omnesis app did not answer"));
      };
      const timer = setTimeout(fail, timeoutMs);
      if (signal?.aborted) {
        fail();
        return;
      }
      signal?.addEventListener("abort", fail, { once: true });
      work.then(
        (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", fail);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", fail);
          reject(error instanceof Error ? error : new TypeError(String(error)));
        }
      );
    });
  }
  async function readNativeStatus(send, timeoutMs = NATIVE_MESSAGE_TIMEOUT_MS) {
    try {
      return parseNativeStatus(await withDeadline(send({ type: "status" }), timeoutMs));
    } catch {
      return null;
    }
  }
  function response(status, body, retryAfter) {
    return {
      status,
      headers: {
        get: (name) => name.toLowerCase() === "retry-after" ? retryAfter ?? null : null
      },
      text: () => Promise.resolve(body)
    };
  }
  function createNativeFetch(send, options) {
    const timeoutMs = options.timeoutMs ?? NATIVE_MESSAGE_TIMEOUT_MS;
    return async (input, init) => {
      const url = new URL(input);
      const path = `${url.pathname}${url.search}`;
      if (!isAllowedNativeRequest(init.method, path)) return response(400, "");
      const deviceId = await options.deviceId();
      if (!deviceId) return response(401, "");
      const hasBody = init.method !== "GET" && init.method !== "HEAD" && init.body !== "";
      const raw = await withDeadline(
        send({
          type: "request",
          deviceId,
          method: init.method,
          path,
          ...hasBody ? { body: init.body } : {}
        }),
        timeoutMs,
        init.signal
      );
      const parsed = parseNativeResponse(raw);
      if (!parsed) throw new TypeError("The Omnesis app sent an unreadable answer");
      if (parsed.ok) return response(parsed.status, parsed.body, parsed.retryAfter);
      if (parsed.reason === "unpaired") {
        options.onUnpaired?.();
        return response(401, "");
      }
      if (parsed.reason === "refused") return response(400, "");
      throw new TypeError("The gateway could not be reached");
    };
  }

  // src/safari/storage.ts
  function safariHandoffStorage(storage) {
    return {
      get: (keys) => storage.get(keys),
      set: (items) => storage.set(items),
      remove: (keys) => storage.remove(keys),
      getKeys: async () => typeof storage.getKeys === "function" ? storage.getKeys() : Object.keys(await storage.get(null))
    };
  }

  // src/safari/messages.ts
  var SAFARI_SYNC_MESSAGE_TYPE = "safari-sync";
  function isDomain(value) {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_CAPTURE_DOMAIN_CHARS;
  }
  function isSafariPopupMessage(message) {
    if (typeof message !== "object" || message === null) return false;
    const candidate = message;
    switch (candidate.type) {
      case "safari-status":
      case "safari-resume":
        return true;
      case "safari-set-pause":
        return candidate.until === null || typeof candidate.until === "number" && Number.isInteger(candidate.until) && candidate.until >= 0;
      case "safari-exclude":
      case "safari-include":
        return isDomain(candidate.domain);
      default:
        return false;
    }
  }

  // src/safari/background.ts
  var SAFARI_GATEWAY_HOST_KEY = "omnesis.safari.gatewayHost.v1";
  var SAFARI_PROFILE_LABEL = "Safari";
  var SAFARI_DRAIN_ALARM = "omnesis.safari.drain";
  var SAFARI_RETRY_ALARM = "omnesis.safari.retry-drain";
  var DRAIN_PERIOD_MINUTES = 1;
  var SAFARI_PAIRING_SYNCED_KEY = "omnesis.safari.pairingSyncedAt.v1";
  var PAIRING_SYNC_INTERVAL_MS = 6e4;
  var UNPAIRED_SYNC_INTERVAL_MS = 5e3;
  var NATIVE_CREDENTIAL_PLACEHOLDER = "native";
  function isObjectWithType(message, type) {
    return typeof message === "object" && message !== null && message.type === type;
  }
  function createSafariBackground(deps) {
    const { storage, sendNative, runtimeId } = deps;
    const now = deps.now ?? (() => Date.now());
    const handoffs = safariHandoffStorage(storage);
    const store = {
      async get(key) {
        const value = (await storage.get(key))[key];
        return typeof value === "string" ? value : void 0;
      },
      async set(key, value) {
        await storage.set({ [key]: value });
      }
    };
    const sessionId = crypto.randomUUID();
    let clientGeneration = 0;
    let pairingSync = null;
    let policyRefresh = null;
    let queueWork = Promise.resolve();
    function serializeQueueWork(work) {
      const result = queueWork.then(work, work);
      queueWork = result.then(
        () => void 0,
        () => void 0
      );
      return result;
    }
    async function loadPairing() {
      return parsePairing((await storage.get(PAIRING_KEY))[PAIRING_KEY]);
    }
    const nativeFetch = createNativeFetch(sendNative, {
      deviceId: async () => (await loadPairing())?.deviceId ?? null,
      ...deps.nativeTimeoutMs !== void 0 ? { timeoutMs: deps.nativeTimeoutMs } : {},
      // The app is unpaired, or paired as another device; stop the pages now
      // instead of at the next sync.
      onUnpaired: () => void syncPairing(true).catch(() => void 0)
    });
    async function loadGatewayHost() {
      const host = (await storage.get(SAFARI_GATEWAY_HOST_KEY))[SAFARI_GATEWAY_HOST_KEY];
      return typeof host === "string" ? host : "";
    }
    async function forgetPairingState() {
      await clearPendingHandoffs(handoffs);
      await clearPushQueue(store);
      await clearPushObservability(store);
      await clearPushHealth(store);
      await clearPushServerState(store);
      await clearCachedPolicy(store);
    }
    function syncPairing(force = false) {
      if (pairingSync) {
        if (!force || pairingSync.forced) return pairingSync.promise;
        const again = () => syncPairing(true);
        return pairingSync.promise.then(again, again);
      }
      const promise = serializeQueueWork(() => syncPairingWork(force));
      const entry = { promise, forced: force };
      pairingSync = entry;
      const done = () => {
        if (pairingSync === entry) pairingSync = null;
      };
      promise.then(done, done);
      return promise;
    }
    async function syncPairingWork(force) {
      const current = await loadPairing();
      if (!force) {
        const syncedAt = (await storage.get(SAFARI_PAIRING_SYNCED_KEY))[SAFARI_PAIRING_SYNCED_KEY];
        const interval = current ? PAIRING_SYNC_INTERVAL_MS : UNPAIRED_SYNC_INTERVAL_MS;
        if (typeof syncedAt === "number" && Math.abs(now() - syncedAt) < interval) return current;
      }
      const status = await readNativeStatus(sendNative, deps.nativeTimeoutMs);
      if (!status) return current;
      await storage.set({ [SAFARI_PAIRING_SYNCED_KEY]: now() });
      if (!status.paired) {
        if (current) {
          await forgetPairingState();
          await storage.remove([PAIRING_KEY, SAFARI_GATEWAY_HOST_KEY]);
        }
        return null;
      }
      if (current?.deviceId !== status.deviceId) {
        await forgetPairingState();
        const pairing = {
          gatewayUrl: SAFARI_GATEWAY_ORIGIN,
          scopes: [REQUIRED_WEB_SCOPE],
          deviceId: status.deviceId,
          pairedAt: now()
        };
        await storage.set({
          [SAFARI_GATEWAY_HOST_KEY]: status.gatewayHost,
          [CAPTURE_PERMISSION_STATE_KEY]: true,
          [PAIRING_KEY]: JSON.stringify(pairing)
        });
        return pairing;
      }
      if (await loadGatewayHost() !== status.gatewayHost) {
        await storage.set({ [SAFARI_GATEWAY_HOST_KEY]: status.gatewayHost });
      }
      return current;
    }
    async function buildClient() {
      if (!await loadPairing()) return null;
      clientGeneration += 1;
      return new PushClient({
        gatewayUrl: SAFARI_GATEWAY_ORIGIN,
        token: NATIVE_CREDENTIAL_PLACEHOLDER,
        fetch: nativeFetch,
        store,
        batchSize: 1,
        observationSessionId: sessionId,
        observationGeneration: clientGeneration,
        now
      });
    }
    function policyClient() {
      return new CapturePolicyClient(
        SAFARI_GATEWAY_ORIGIN,
        NATIVE_CREDENTIAL_PLACEHOLDER,
        nativeFetch
      );
    }
    function refreshPolicy(pairing, fallback) {
      if (policyRefresh?.pairing === pairing.deviceId) return policyRefresh.promise;
      const promise = (async () => {
        try {
          const policy = await policyClient().read();
          const current = await loadPairing();
          if (current?.deviceId !== pairing.deviceId) return fallback;
          await writeCachedPolicy(store, policy, now());
          return policy;
        } catch {
          return fallback;
        } finally {
          if (policyRefresh?.pairing === pairing.deviceId) policyRefresh = null;
        }
      })();
      policyRefresh = { pairing: pairing.deviceId, promise };
      return promise;
    }
    async function currentPolicy(opts = {}) {
      const pairing = await loadPairing();
      if (!pairing) return null;
      const cached = await readCachedPolicy(store);
      if (cached && !opts.refresh && !policyIsStale(cached, now())) return cached.policy;
      const refresh = refreshPolicy(pairing, cached?.policy ?? null);
      if (cached && !opts.refresh) {
        void refresh;
        return cached.policy;
      }
      return refresh;
    }
    async function judgeEligibility(url) {
      const pairing = await loadPairing() ?? await syncPairing();
      if (!pairing) return { eligible: false, reason: "unpaired", skipPasswordForms: true };
      const policy = await currentPolicy();
      if (!policy) return { eligible: false, reason: "no-policy", skipPasswordForms: true };
      const verdict = judgeCaptureUrl(policy, url, {
        gatewayHost: await loadGatewayHost(),
        now: now()
      });
      const skipPasswordForms = policy.rules.skipPasswordForms;
      return verdict.allowed ? { eligible: true, skipPasswordForms } : { eligible: false, reason: verdict.reason, skipPasswordForms };
    }
    function handleCapture(message) {
      return serializeQueueWork(async () => {
        const finish = async (ack) => {
          if (message.handoffKey) await storage.remove(message.handoffKey);
          return ack;
        };
        const refuse = () => finish({ ok: true, accepted: false });
        const pairing = await loadPairing();
        if (!pairing) return refuse();
        if (message.handoffKey && message.pairingId !== await capturePairingId(pairing)) {
          return refuse();
        }
        const client = await buildClient();
        if (!client) return refuse();
        if (await client.getServerState() && await client.queueDepth() > 0) return refuse();
        const policy = await currentPolicy();
        if (!policy) return refuse();
        const { emission } = message;
        try {
          const emissionUrl = new URL(emission.normalizedUrl);
          if (emissionUrl.username || emissionUrl.password) return refuse();
        } catch {
          return refuse();
        }
        const externalId = await hashText(emission.normalizedUrl);
        const verdict = judgeCaptureUrl(policy, emission.normalizedUrl, {
          gatewayHost: await loadGatewayHost(),
          now: now(),
          externalId
        });
        if (!verdict.allowed) return refuse();
        const browserProfile = { deviceId: pairing.deviceId, label: SAFARI_PROFILE_LABEL };
        if (emission.contentChanged) {
          await client.enqueueDocument(
            await buildWebPageDocument({
              normalizedUrl: emission.normalizedUrl,
              title: emission.title,
              text: emission.text,
              contentHash: emission.contentHash,
              visitedAt: emission.visitedAt,
              browserProfile
            })
          );
        }
        if (emission.kind === "visit") {
          await client.enqueueVisit(
            buildPageVisit({
              normalizedUrl: emission.normalizedUrl,
              title: emission.title,
              visitedAt: emission.visitedAt,
              dwellMs: emission.dwellMs,
              browserProfile
            })
          );
        }
        return finish({ ok: true, accepted: true });
      });
    }
    async function recoverPendingHandoffs() {
      const pairing = await loadPairing();
      const pairingId = pairing ? await capturePairingId(pairing) : null;
      for (const item of await readPendingHandoffs(handoffs)) {
        try {
          if (!item.record || !pairingId || item.record.pairingId !== pairingId) {
            await storage.remove(item.key);
            continue;
          }
          await handleCapture({
            type: "capture",
            emission: item.record.emission,
            handoffKey: item.key,
            pairingId: item.record.pairingId
          });
        } catch {
        }
      }
      if ((await pendingHandoffKeys(handoffs)).length === 0) {
        await storage.set({ [CAPTURE_HANDOFF_FAILURE_KEY]: "" });
      }
    }
    function keepDrainAlarm(waiting) {
      if (waiting) deps.alarms?.create(SAFARI_DRAIN_ALARM, { periodInMinutes: DRAIN_PERIOD_MINUTES });
      else void Promise.resolve(deps.alarms?.clear(SAFARI_DRAIN_ALARM)).catch(() => void 0);
    }
    async function drainWork() {
      const client = await buildClient();
      if (!client || await client.queueDepth() === 0) {
        keepDrainAlarm(false);
        return false;
      }
      const result = await client.drain();
      keepDrainAlarm(await client.queueDepth() > 0);
      const readyAgain = result.nextEligibleAt !== null && result.nextEligibleAt <= now();
      if (result.nextEligibleAt !== null && !readyAgain) {
        const delayMs = Math.max(0, result.nextEligibleAt - now());
        if (delayMs < DRAIN_PERIOD_MINUTES * 60 * 1e3) {
          deps.alarms?.create(SAFARI_RETRY_ALARM, { when: result.nextEligibleAt });
        }
      }
      if (result.suppressed > 0) await currentPolicy({ refresh: true });
      return readyAgain;
    }
    function drain() {
      return serializeQueueWork(drainWork).then(
        (readyAgain) => {
          if (readyAgain) void drain();
        },
        () => void 0
      );
    }
    async function readStatus(opts) {
      const pairing = opts.fresh ? await syncPairing(true) : await loadPairing();
      if (!pairing) return { paired: false };
      const policy = await currentPolicy({ refresh: opts.fresh });
      const client = await buildClient();
      const [gatewayHost, queued, health, connectivity, recent] = await Promise.all([
        loadGatewayHost(),
        client ? client.queueDepth() : 0,
        client ? client.getHealth() : null,
        client ? client.getConnectivity() : null,
        client ? client.getRecentDeliveries() : []
      ]);
      const pausedUntil = policy?.pause ? policy.pause.until : void 0;
      const paused = policy?.pause !== null && policy?.pause !== void 0 && (policy.pause.until === null || policy.pause.until > now());
      return {
        paired: true,
        gatewayHost,
        policyKnown: policy !== null,
        paused,
        ...paused && typeof pausedUntil === "number" ? { pausedUntil } : {},
        excludedDomains: policy?.excludedDomains ?? [],
        queued,
        refused: health?.ok === false,
        reachable: connectivity?.reachable !== false,
        ...recent[0] ? { lastCapturedAt: recent[0].at } : {}
      };
    }
    async function handlePopupMessage(message) {
      if (message.type === "safari-status") {
        return { ok: true, status: await readStatus({ fresh: true }) };
      }
      if (!await loadPairing()) return { ok: false, reason: "Pair the Omnesis app first" };
      await serializeQueueWork(async () => {
        const client = policyClient();
        let policy;
        if (message.type === "safari-set-pause") policy = await client.setPause(message.until);
        else if (message.type === "safari-resume") policy = await client.clearPause();
        else if (message.type === "safari-exclude") {
          policy = (await client.addExcludedDomain(message.domain, false)).policy;
        } else policy = await client.removeExcludedDomain(message.domain);
        await writeCachedPolicy(store, policy, now());
      });
      return { ok: true, status: await readStatus({ fresh: false }) };
    }
    function respond(work, sendResponse, onError) {
      work.then(
        (value) => sendResponse(value),
        (error) => sendResponse(onError(error))
      );
    }
    return {
      async start() {
        try {
          if (await syncPairing()) await currentPolicy();
          await recoverPendingHandoffs();
        } catch {
        } finally {
          await drain();
        }
      },
      handleMessage(message, sender, sendResponse) {
        if (sender.id !== runtimeId) return false;
        const fromPage = sender.tab?.id !== void 0 && sender.tab.incognito !== true;
        if (fromPage && isCaptureMessage(message)) {
          respond(
            handleCapture(message).then((ack) => {
              if (ack.ok && ack.accepted) void drain();
              return ack;
            }),
            sendResponse,
            () => ({ ok: false, reason: "queue-unavailable" })
          );
          return true;
        }
        if (fromPage && isObjectWithType(message, "capture-eligibility") && typeof message.url === "string" && message.url.length <= MAX_CAPTURE_URL_CHARS) {
          respond(
            judgeEligibility(message.url),
            sendResponse,
            () => ({ eligible: true, skipPasswordForms: true })
          );
          return true;
        }
        if (fromPage && isObjectWithType(message, SAFARI_SYNC_MESSAGE_TYPE)) {
          respond(
            syncPairing().then((pairing) => ({ paired: pairing !== null })),
            sendResponse,
            () => ({ paired: false })
          );
          return true;
        }
        if (sender.tab === void 0 && sender.url?.startsWith(deps.popupUrl) === true && isSafariPopupMessage(message)) {
          respond(
            handlePopupMessage(message),
            sendResponse,
            (error) => ({
              ok: false,
              reason: error instanceof Error ? error.message : "The gateway did not answer"
            })
          );
          return true;
        }
        return false;
      },
      handleAlarm(name) {
        if (name === SAFARI_DRAIN_ALARM || name === SAFARI_RETRY_ALARM) void drain();
      }
    };
  }

  // src/safari/background-entry.ts
  var api = globalThis.browser ?? chrome;
  var runtime = api.runtime;
  var background = createSafariBackground({
    storage: api.storage.local,
    // Safari ignores the application name on iOS and always reaches the app
    // that contains this extension.
    sendNative: (message) => runtime.sendNativeMessage("application.id", message),
    alarms: api.alarms,
    runtimeId: runtime.id ?? "",
    popupUrl: runtime.getURL("popup.html")
  });
  runtime.onMessage.addListener(
    (message, sender, sendResponse) => background.handleMessage(message, sender, sendResponse)
  );
  api.alarms.onAlarm.addListener((alarm) => background.handleAlarm(alarm.name));
  void background.start().catch(() => void 0);
})();
