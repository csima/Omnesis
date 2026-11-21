// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeCaptureDomain } from "@omnesis/provider-web/capture-policy";
import type { CaptureContentStatus } from "../chrome/messages.js";
import type { SafariPopupAck, SafariPopupMessage, SafariStatus } from "./messages.js";

export const PAUSE_ONE_HOUR_MS = 60 * 60 * 1000;

export type PopupState = "loading" | "unpaired" | "capturing" | "paused" | "waiting" | "blocked";

/**
 * What the open page's own script says about itself: `absent` when Safari has
 * not let the extension onto the page, so no script is there to answer.
 */
export type PageCapture = CaptureContentStatus | "absent" | "unknown";

export interface PopupModel {
  state: PopupState;
  headline: string;
  detail: string;
  footnote: string;
  /** The open page's site and whether the capture settings exclude it. */
  site: { domain: string; excluded: boolean } | null;
  showPause: boolean;
  showResume: boolean;
}

/** The site a page belongs to, when it is one capture could ever apply to. */
export function siteOf(pageUrl: string | undefined): string {
  if (!pageUrl) return "";
  try {
    const url = new URL(pageUrl);
    return url.protocol === "https:" ? normalizeCaptureDomain(url.hostname) : "";
  } catch {
    return "";
  }
}

function coveredBy(domain: string, excluded: readonly string[]): string | null {
  return excluded.find((entry) => domain === entry || domain.endsWith(`.${entry}`)) ?? null;
}

function timeOfDay(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function popupModel(
  status: SafariStatus | null,
  pageUrl: string | undefined,
  now: number,
  page: PageCapture = "unknown",
): PopupModel {
  const none = { site: null, showPause: false, showResume: false };
  if (!status) {
    return { state: "loading", headline: "Checking…", detail: "", footnote: "", ...none };
  }
  if (!status.paired) {
    return {
      state: "unpaired",
      headline: "Not connected yet",
      detail:
        "Open the Omnesis app and pair it with your gateway. Pages you read in Safari are then saved to your index.",
      footnote: "",
      ...none,
    };
  }
  const domain = siteOf(pageUrl);
  const excludedBy = domain ? coveredBy(domain, status.excludedDomains) : null;
  const site = domain ? { domain: excludedBy ?? domain, excluded: excludedBy !== null } : null;
  const waiting =
    status.queued > 0
      ? `${status.queued} ${status.queued === 1 ? "page is" : "pages are"} waiting to be sent.`
      : "";
  const last =
    status.lastCapturedAt !== undefined && now - status.lastCapturedAt < 24 * 60 * 60 * 1000
      ? `Last page saved at ${timeOfDay(status.lastCapturedAt)}.`
      : "";
  const footnote = [waiting, last].filter(Boolean).join(" ");
  if (!status.policyKnown) {
    return {
      state: "waiting",
      headline: "Waiting for your gateway",
      detail: `Nothing is captured until ${status.gatewayHost} has sent its capture settings.`,
      footnote,
      site: null,
      showPause: false,
      showResume: false,
    };
  }
  if (status.paused) {
    return {
      state: "paused",
      headline: "Capture is paused",
      detail:
        status.pausedUntil !== undefined
          ? `Resumes at ${timeOfDay(status.pausedUntil)}.`
          : "Paused until you resume it.",
      footnote,
      site,
      showPause: false,
      showResume: true,
    };
  }
  if (status.refused) {
    return {
      state: "waiting",
      headline: "Open the Omnesis app",
      detail:
        "Your gateway refused Safari's connection. Opening the app reconnects it; pages already read are kept on this device.",
      footnote,
      site,
      showPause: false,
      showResume: false,
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
      showResume: false,
    };
  }
  const capturing = { footnote, site, showPause: true, showResume: false };
  if (site?.excluded) {
    return {
      state: "capturing",
      headline: "This site is not captured",
      detail: `Connected to ${status.gatewayHost}.`,
      ...capturing,
    };
  }
  if (site && page === "absent") {
    return {
      state: "blocked",
      headline: "Not allowed on this site yet",
      detail:
        "Allow Omnesis for this website in Safari's page menu, then reload the page. Until then nothing here is read.",
      ...capturing,
    };
  }
  if (site && page !== "unknown" && page !== "absent" && page.state === "excluded") {
    return {
      state: "capturing",
      headline: "This page is not captured",
      detail:
        page.reason === "sensitive-field"
          ? "Pages with sign-in, verification or payment fields are never read."
          : `Connected to ${status.gatewayHost}.`,
      ...capturing,
    };
  }
  return {
    state: "capturing",
    headline: "Saving pages you read",
    detail: `Connected to ${status.gatewayHost}.`,
    ...capturing,
  };
}

export interface PopupDeps {
  document: Document;
  send: (message: SafariPopupMessage) => Promise<SafariPopupAck | undefined>;
  activePageUrl: () => Promise<string | undefined>;
  /** Ask the open page's script for its capture state; rejects when no script is there. */
  pageCapture: () => Promise<CaptureContentStatus | undefined>;
  now: () => number;
}

/** Wire the popup's markup to the background. Returns once the first status is shown. */
export async function startPopup(deps: PopupDeps): Promise<void> {
  const { document: doc } = deps;
  const byId = <T extends HTMLElement>(id: string): T => {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`popup markup is missing #${id}`);
    return node as T;
  };
  const headline = byId("headline");
  const detail = byId("detail");
  const footnote = byId("footnote");
  const error = byId("error");
  const siteCard = byId("site");
  const siteDomain = byId("site-domain");
  const siteToggle = byId<HTMLButtonElement>("site-toggle");
  const pauseCard = byId("pause");
  const pauseHour = byId<HTMLButtonElement>("pause-hour");
  const pauseOpen = byId<HTMLButtonElement>("pause-open");
  const resume = byId<HTMLButtonElement>("resume");
  const buttons = [siteToggle, pauseHour, pauseOpen, resume];

  const pageUrl = await deps.activePageUrl().catch(() => undefined);
  const page: PageCapture = await deps.pageCapture().then(
    (answer) => answer ?? "absent",
    () => "absent" as const,
  );
  let model = popupModel(null, pageUrl, deps.now(), page);

  function render(status: SafariStatus | null): void {
    model = popupModel(status, pageUrl, deps.now(), page);
    doc.body.dataset["state"] = model.state;
    headline.textContent = model.headline;
    detail.textContent = model.detail;
    footnote.textContent = model.footnote;
    siteCard.hidden = model.site === null;
    if (model.site) {
      siteDomain.textContent = model.site.domain;
      siteToggle.textContent = model.site.excluded
        ? "Capture this site again"
        : "Don't capture this site";
    }
    pauseCard.hidden = !model.showPause && !model.showResume;
    pauseHour.hidden = !model.showPause;
    pauseOpen.hidden = !model.showPause;
    resume.hidden = !model.showResume;
  }

  async function run(message: SafariPopupMessage): Promise<void> {
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
      domain: model.site.domain,
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
