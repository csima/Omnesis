"use strict";
(() => {
  // src/chrome/message-timeout.ts
  function messageWithTimeout(work, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("extension message timed out")), timeoutMs);
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

  // src/chrome/messages.ts
  var CAPTURE_STATUS_MESSAGE = { type: "capture-status" };

  // ../packages/providers/web/src/capture-policy.ts
  var MAX_CAPTURE_DOMAIN_CHARS = 253;
  function normalizeCaptureDomain(input) {
    const trimmed = input.trim().toLowerCase().replace(/^\.+/, "");
    if (!trimmed) return "";
    let host;
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
    return labels.length >= 2 && labels.every(
      (label) => label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ) ? host : "";
  }

  // src/safari/popup-view.ts
  var PAUSE_ONE_HOUR_MS = 60 * 60 * 1e3;
  function siteOf(pageUrl) {
    if (!pageUrl) return "";
    try {
      const url = new URL(pageUrl);
      return url.protocol === "https:" ? normalizeCaptureDomain(url.hostname) : "";
    } catch {
      return "";
    }
  }
  function coveredBy(domain, excluded) {
    return excluded.find((entry) => domain === entry || domain.endsWith(`.${entry}`)) ?? null;
  }
  function timeOfDay(at) {
    return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function popupModel(status, pageUrl, now, page = "unknown") {
    const none = { site: null, showPause: false, showResume: false };
    if (!status) {
      return { state: "loading", headline: "Checking…", detail: "", footnote: "", ...none };
    }
    if (!status.paired) {
      return {
        state: "unpaired",
        headline: "Not connected yet",
        detail: "Open the Omnesis app and pair it with your gateway. Pages you read in Safari are then saved to your index.",
        footnote: "",
        ...none
      };
    }
    const domain = siteOf(pageUrl);
    const excludedBy = domain ? coveredBy(domain, status.excludedDomains) : null;
    const site = domain ? { domain: excludedBy ?? domain, excluded: excludedBy !== null } : null;
    const waiting = status.queued > 0 ? `${status.queued} ${status.queued === 1 ? "page is" : "pages are"} waiting to be sent.` : "";
    const last = status.lastCapturedAt !== void 0 && now - status.lastCapturedAt < 24 * 60 * 60 * 1e3 ? `Last page saved at ${timeOfDay(status.lastCapturedAt)}.` : "";
    const footnote = [waiting, last].filter(Boolean).join(" ");
    if (!status.policyKnown) {
      return {
        state: "waiting",
        headline: "Waiting for your gateway",
        detail: `Nothing is captured until ${status.gatewayHost} has sent its capture settings.`,
        footnote,
        site: null,
        showPause: false,
        showResume: false
      };
    }
    if (status.paused) {
      return {
        state: "paused",
        headline: "Capture is paused",
        detail: status.pausedUntil !== void 0 ? `Resumes at ${timeOfDay(status.pausedUntil)}.` : "Paused until you resume it.",
        footnote,
        site,
        showPause: false,
        showResume: true
      };
    }
    if (status.refused) {
      return {
        state: "waiting",
        headline: "Open the Omnesis app",
        detail: "Your gateway refused Safari's connection. Opening the app reconnects it; pages already read are kept on this device.",
        footnote,
        site,
        showPause: false,
        showResume: false
      };
    }
    if (!status.reachable) {
      return {
        state: "waiting",
        headline: "Can't reach your gateway",
        detail: `Pages are kept on this device and sent when ${status.gatewayHost} answers again.`,
        footnote,
        site,
        showPause: true,
        showResume: false
      };
    }
    const capturing = { footnote, site, showPause: true, showResume: false };
    if (site?.excluded) {
      return {
        state: "capturing",
        headline: "This site is not captured",
        detail: `Connected to ${status.gatewayHost}.`,
        ...capturing
      };
    }
    if (site && page === "absent") {
      return {
        state: "blocked",
        headline: "Not allowed on this site yet",
        detail: "Allow Omnesis for this website in Safari's page menu, then reload the page. Until then nothing here is read.",
        ...capturing
      };
    }
    if (site && page !== "unknown" && page !== "absent" && page.state === "excluded") {
      return {
        state: "capturing",
        headline: "This page is not captured",
        detail: page.reason === "sensitive-field" ? "Pages with sign-in, verification or payment fields are never read." : `Connected to ${status.gatewayHost}.`,
        ...capturing
      };
    }
    return {
      state: "capturing",
      headline: "Saving pages you read",
      detail: `Connected to ${status.gatewayHost}.`,
      ...capturing
    };
  }
  async function startPopup(deps) {
    const { document: doc } = deps;
    const byId = (id) => {
      const node = doc.getElementById(id);
      if (!node) throw new Error(`popup markup is missing #${id}`);
      return node;
    };
    const headline = byId("headline");
    const detail = byId("detail");
    const footnote = byId("footnote");
    const error = byId("error");
    const siteCard = byId("site");
    const siteDomain = byId("site-domain");
    const siteToggle = byId("site-toggle");
    const pauseCard = byId("pause");
    const pauseHour = byId("pause-hour");
    const pauseOpen = byId("pause-open");
    const resume = byId("resume");
    const buttons = [siteToggle, pauseHour, pauseOpen, resume];
    const pageUrl = await deps.activePageUrl().catch(() => void 0);
    const page = await deps.pageCapture().then(
      (answer) => answer ?? "absent",
      () => "absent"
    );
    let model = popupModel(null, pageUrl, deps.now(), page);
    function render(status) {
      model = popupModel(status, pageUrl, deps.now(), page);
      doc.body.dataset["state"] = model.state;
      headline.textContent = model.headline;
      detail.textContent = model.detail;
      footnote.textContent = model.footnote;
      siteCard.hidden = model.site === null;
      if (model.site) {
        siteDomain.textContent = model.site.domain;
        siteToggle.textContent = model.site.excluded ? "Capture this site again" : "Don't capture this site";
      }
      pauseCard.hidden = !model.showPause && !model.showResume;
      pauseHour.hidden = !model.showPause;
      pauseOpen.hidden = !model.showPause;
      resume.hidden = !model.showResume;
    }
    async function run(message) {
      error.hidden = true;
      for (const button of buttons) button.disabled = true;
      try {
        const ack = await deps.send(message);
        if (ack?.ok) render(ack.status);
        else {
          error.textContent = ack?.reason ?? "The Omnesis app did not answer.";
          error.hidden = false;
        }
      } catch {
        error.textContent = "The Omnesis app did not answer.";
        error.hidden = false;
      } finally {
        for (const button of buttons) button.disabled = false;
      }
    }
    siteToggle.addEventListener("click", () => {
      if (!model.site) return;
      void run({
        type: model.site.excluded ? "safari-include" : "safari-exclude",
        domain: model.site.domain
      });
    });
    pauseHour.addEventListener("click", () => {
      void run({ type: "safari-set-pause", until: deps.now() + PAUSE_ONE_HOUR_MS });
    });
    pauseOpen.addEventListener("click", () => {
      void run({ type: "safari-set-pause", until: null });
    });
    resume.addEventListener("click", () => {
      void run({ type: "safari-resume" });
    });
    render(null);
    await run({ type: "safari-status" });
  }

  // src/safari/popup.ts
  var api = globalThis.browser ?? chrome;
  var PAGE_ANSWER_TIMEOUT_MS = 1500;
  async function activeTab() {
    return (await api.tabs.query({ active: true, currentWindow: true }))[0];
  }
  void startPopup({
    document,
    send: (message) => api.runtime.sendMessage(message),
    activePageUrl: async () => (await activeTab())?.url,
    pageCapture: async () => {
      const tabId = (await activeTab())?.id;
      if (tabId === void 0) return void 0;
      return messageWithTimeout(
        api.tabs.sendMessage(tabId, CAPTURE_STATUS_MESSAGE),
        PAGE_ANSWER_TIMEOUT_MS
      );
    },
    now: () => Date.now()
  });
})();
