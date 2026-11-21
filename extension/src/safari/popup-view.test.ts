// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { PAUSE_ONE_HOUR_MS, popupModel, siteOf, startPopup } from "./popup-view.js";
import type { SafariPopupAck, SafariPopupMessage, SafariStatus } from "./messages.js";

const NOW = Date.parse("2026-03-01T10:00:00Z");
const paired: Extract<SafariStatus, { paired: true }> = {
  paired: true,
  gatewayHost: "gateway.example.com",
  policyKnown: true,
  paused: false,
  excludedDomains: [],
  queued: 0,
  refused: false,
  reachable: true,
};

describe("siteOf", () => {
  it("names the site of an HTTPS page and nothing else", () => {
    expect(siteOf("https://News.Example.org/story?id=4")).toBe("news.example.org");
    expect(siteOf("http://example.org/")).toBe("");
    expect(siteOf("safari-web-extension://abc/popup.html")).toBe("");
    expect(siteOf("https://localhost/")).toBe("");
    expect(siteOf(undefined)).toBe("");
  });
});

describe("popupModel", () => {
  it("asks an unpaired phone to pair in the app, with no controls", () => {
    const model = popupModel({ paired: false }, "https://example.org/", NOW);
    expect(model).toMatchObject({ state: "unpaired", site: null, showPause: false });
    expect(model.detail).toContain("Open the Omnesis app");
  });

  it("says pages are being saved and offers both controls", () => {
    const model = popupModel(paired, "https://news.example.org/story", NOW);
    expect(model).toMatchObject({
      state: "capturing",
      headline: "Saving pages you read",
      site: { domain: "news.example.org", excluded: false },
      showPause: true,
      showResume: false,
    });
  });

  it("names the excluded entry that covers a subdomain", () => {
    const model = popupModel(
      { ...paired, excludedDomains: ["example.org"] },
      "https://news.example.org/story",
      NOW,
    );
    expect(model.headline).toBe("This site is not captured");
    expect(model.site).toEqual({ domain: "example.org", excluded: true });
  });

  it("shows when a timed pause ends and offers only resume", () => {
    const timed = popupModel(
      { ...paired, paused: true, pausedUntil: NOW + PAUSE_ONE_HOUR_MS },
      "https://example.org/",
      NOW,
    );
    expect(timed).toMatchObject({ state: "paused", showPause: false, showResume: true });
    expect(timed.detail).toMatch(/^Resumes at /);
    expect(popupModel({ ...paired, paused: true }, undefined, NOW).detail).toBe(
      "Paused until you resume it.",
    );
  });

  it("explains a gateway that has not sent its settings or does not answer", () => {
    const noPolicy = popupModel({ ...paired, policyKnown: false }, "https://example.org/", NOW);
    expect(noPolicy).toMatchObject({ state: "waiting", site: null, showPause: false });
    const unreachable = popupModel({ ...paired, reachable: false, queued: 3 }, undefined, NOW);
    expect(unreachable.headline).toBe("Can't reach your gateway");
    expect(unreachable.footnote).toBe("3 pages are waiting to be sent.");
  });

  it("sends the reader to the app when the gateway refuses Safari's credential", () => {
    const refused = popupModel({ ...paired, refused: true, queued: 2 }, undefined, NOW);
    expect(refused).toMatchObject({
      state: "waiting",
      headline: "Open the Omnesis app",
      showPause: false,
    });
    expect(refused.detail).toContain("kept on this device");
  });

  it("says so when Safari has not let the extension onto the open site", () => {
    const blocked = popupModel(paired, "https://news.example.org/story", NOW, "absent");
    expect(blocked).toMatchObject({
      state: "blocked",
      headline: "Not allowed on this site yet",
      site: { domain: "news.example.org", excluded: false },
    });
    expect(popupModel(paired, "https://news.example.org/story", NOW, "unknown").state).toBe(
      "capturing",
    );
    expect(popupModel(paired, undefined, NOW, "absent").headline).toBe("Saving pages you read");
  });

  it("explains a page its own script will not read", () => {
    const signIn = popupModel(paired, "https://shop.example.org/checkout", NOW, {
      state: "excluded",
      reason: "sensitive-field",
    });
    expect(signIn.headline).toBe("This page is not captured");
    expect(signIn.detail).toContain("sign-in");
    expect(
      popupModel(paired, "https://news.example.org/story", NOW, { state: "watching" }).headline,
    ).toBe("Saving pages you read");
  });

  it("counts one waiting page in the singular and names a recent save", () => {
    const model = popupModel(
      { ...paired, queued: 1, lastCapturedAt: NOW - 60_000 },
      undefined,
      NOW,
    );
    expect(model.footnote).toMatch(/^1 page is waiting to be sent\. Last page saved at /);
    expect(
      popupModel({ ...paired, lastCapturedAt: NOW - 3 * 24 * 60 * 60 * 1000 }, undefined, NOW)
        .footnote,
    ).toBe("");
  });
});

describe("startPopup", () => {
  async function open(
    status: SafariStatus,
    pageUrl: string | undefined,
    answer?: (message: SafariPopupMessage) => SafariPopupAck | undefined,
  ) {
    const html = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "../../public-safari/popup.html"),
      "utf8",
    );
    const { document } = parseHTML(html);
    const sent: SafariPopupMessage[] = [];
    await startPopup({
      document: document as unknown as Document,
      send: (message) => {
        sent.push(message);
        return Promise.resolve(
          answer ? answer(message) : ({ ok: true, status } satisfies SafariPopupAck),
        );
      },
      activePageUrl: () => Promise.resolve(pageUrl),
      pageCapture: () => Promise.resolve({ state: "watching" }),
      now: () => NOW,
    });
    const el = (id: string) => document.getElementById(id) as unknown as HTMLButtonElement;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { document, sent, el, settle };
  }

  it("renders the first status into the shipped markup", async () => {
    const { document, sent, el } = await open(paired, "https://news.example.org/story");
    expect(sent).toEqual([{ type: "safari-status" }]);
    expect(document.body.dataset["state"]).toBe("capturing");
    expect(el("headline").textContent).toBe("Saving pages you read");
    expect(el("site").hidden).toBe(false);
    expect(el("site-toggle").textContent).toBe("Don't capture this site");
    expect(el("pause-hour").hidden).toBe(false);
    expect(el("resume").hidden).toBe(true);
  });

  it("hides every control while unpaired", async () => {
    const { el } = await open({ paired: false }, "https://news.example.org/story");
    expect(el("site").hidden).toBe(true);
    expect(el("pause").hidden).toBe(true);
  });

  it("sends the site's exclusion and a one-hour pause, and renders what comes back", async () => {
    let current: SafariStatus = paired;
    const { sent, el, settle } = await open(paired, "https://news.example.org/story", (message) => {
      if (message.type === "safari-exclude") {
        current = { ...paired, excludedDomains: [message.domain] };
      }
      if (message.type === "safari-set-pause") current = { ...paired, paused: true };
      return { ok: true, status: current };
    });

    el("site-toggle").click();
    await settle();
    expect(sent.at(-1)).toEqual({ type: "safari-exclude", domain: "news.example.org" });
    expect(el("site-toggle").textContent).toBe("Capture this site again");

    el("pause-hour").click();
    await settle();
    expect(sent.at(-1)).toEqual({ type: "safari-set-pause", until: NOW + PAUSE_ONE_HOUR_MS });
    expect(el("resume").hidden).toBe(false);
    expect(el("pause-hour").hidden).toBe(true);
  });

  it("shows the reason when a change is refused and leaves the buttons usable", async () => {
    const { el, settle } = await open(paired, "https://news.example.org/story", (message) =>
      message.type === "safari-status"
        ? { ok: true, status: paired }
        : { ok: false, reason: "The gateway did not answer" },
    );
    el("pause-open").click();
    await settle();
    expect(el("error").hidden).toBe(false);
    expect(el("error").textContent).toBe("The gateway did not answer");
    expect(el("pause-open").disabled).toBe(false);
  });
});
