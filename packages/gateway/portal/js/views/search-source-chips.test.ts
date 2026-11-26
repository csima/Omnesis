// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — mounts the plain-JS portal search view in a lightweight DOM.
// The source chips under the search box: one per registered source type, and
// each one an edit to the query text rather than state of its own. All
// example data is invented.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  search: vi.fn(),
  searchAgentContext: vi.fn(),
  getSearchReadiness: vi.fn(),
  getDocumentsPeopleBulk: vi.fn(),
  getDocumentSummariesBulk: vi.fn(),
  getPeople: vi.fn(),
  getStatus: vi.fn(),
  getAdminSources: vi.fn(),
}));
vi.mock("../api.js", () => api);
vi.mock("../components/facets.js", () => ({ FacetPanel: () => null }));
vi.mock("../components/pipeline-debug.js", () => ({ PipelineDebug: () => null }));
vi.mock("../components/indexer-warming-card.js", () => ({ IndexerWarmingCard: () => null }));
vi.mock("../lib/format.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sourceLabel: (id) => ({ "alpha-mail": "Alpha", "beta-pages": "Beta", "gamma-trial": "Gamma" })[id] ?? id,
  sourceIsExperimental: (type) => type === "gamma-trial",
}));
import { SearchView } from "./search.js";

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const chipLabels = (host) => [...host.querySelectorAll(".search-source-chip")].map((c) => c.textContent.trim());
const chip = (host, label) => [...host.querySelectorAll(".search-source-chip")].find((c) => c.textContent.trim() === label);
const selectedLabels = (host) =>
  [...host.querySelectorAll(".search-source-chip")]
    .filter((c) => c.getAttribute("aria-pressed") === "true")
    .map((c) => c.textContent.trim());

async function mount(host, props = {}) {
  await act(async () => {
    render(h(SearchView, props), host);
  });
  await flush();
}

async function click(el) {
  await act(async () => {
    el.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  await flush();
}

async function type(host, text) {
  await act(async () => {
    const input = host.querySelector(".search-input");
    input.value = text;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

let host;
beforeEach(() => {
  vi.resetAllMocks();
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("requestAnimationFrame", (callback) => {
    callback();
    return 1;
  });
  const cache = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key) => cache.get(key) ?? null,
    setItem: (key, value) => cache.set(key, value),
    removeItem: (key) => cache.delete(key),
  });
  vi.stubGlobal("location", { pathname: "/portal/search", search: "" });
  vi.stubGlobal("history", { replaceState: vi.fn(), pushState: vi.fn() });
  host = dom.document.querySelector("main");
  api.getSearchReadiness.mockResolvedValue({ indexer: { status: "ready" } });
  api.getPeople.mockResolvedValue({ people: [] });
  api.getDocumentsPeopleBulk.mockResolvedValue({ docs: {} });
  api.search.mockImplementation(async (text) => ({ query: { original: text }, results: [] }));
  api.getAdminSources.mockResolvedValue({
    items: [
      { id: "alpha-mail:maya@example.com", type: "alpha-mail" },
      { id: "alpha-mail:jamie@example.org", type: "alpha-mail" },
      { id: "beta-pages", type: "beta-pages" },
      { id: "gamma-trial:one", type: "gamma-trial" },
    ],
    internalSources: [{ id: "delta-internal" }],
  });
  api.getStatus.mockResolvedValue({
    experimental: false,
    documents: {
      bySource: {
        "alpha-mail:maya@example.com": 4,
        "alpha-mail:jamie@example.org": 3,
        "beta-pages": 12,
        "gamma-trial:one": 30,
        "delta-internal": 50,
      },
    },
  });
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

describe("search source chips", () => {
  it("offers one chip per registered type, most documents first, without internal or experimental sources", async () => {
    await mount(host);
    expect(chipLabels(host)).toEqual(["Beta", "Alpha"]);
    expect(selectedLabels(host)).toEqual([]);
  });

  it("offers experimental sources when the gateway runs in experimental mode", async () => {
    api.getStatus.mockResolvedValue({
      experimental: true,
      documents: { bySource: { "beta-pages": 12, "gamma-trial:one": 30 } },
    });
    await mount(host);
    expect(chipLabels(host)).toEqual(["Gamma", "Beta"]);
  });

  it("shows no chips when the sources cannot be read", async () => {
    api.getAdminSources.mockRejectedValue(new Error("forbidden"));
    await mount(host);
    expect(host.querySelector(".search-source-chips")).toBeNull();
    expect(host.querySelector(".search-input")).not.toBeNull();
  });

  it("with a blank query, a chip only sets its token", async () => {
    await mount(host);
    await click(chip(host, "Beta"));
    expect(host.querySelector(".search-input").value).toBe("source:beta-pages");
    expect(selectedLabels(host)).toEqual(["Beta"]);
    expect(api.search).not.toHaveBeenCalled();
  });

  it("with a query, a chip adds its token and searches, and pressing it again removes the token", async () => {
    await mount(host);
    await type(host, "quarterly budget");
    await click(chip(host, "Alpha"));
    expect(api.search).toHaveBeenLastCalledWith("quarterly budget source:alpha-mail", { verbose: false });
    expect(selectedLabels(host)).toEqual(["Alpha"]);

    await click(chip(host, "Beta"));
    expect(api.search).toHaveBeenLastCalledWith("quarterly budget source:alpha-mail source:beta-pages", { verbose: false });
    expect(selectedLabels(host)).toEqual(["Beta", "Alpha"]);

    await click(chip(host, "Alpha"));
    expect(api.search).toHaveBeenLastCalledWith("quarterly budget source:beta-pages", { verbose: false });
    expect(host.querySelector(".search-input").value).toBe("quarterly budget source:beta-pages");
    expect(selectedLabels(host)).toEqual(["Beta"]);
  });

  it("a token typed by hand selects its chip, in any case", async () => {
    await mount(host);
    await type(host, "invoices SOURCE:Beta-Pages");
    expect(selectedLabels(host)).toEqual(["Beta"]);
    await type(host, 'invoices "source:beta-pages"');
    expect(selectedLabels(host)).toEqual([]);
  });

  it("a query from the address selects its chips", async () => {
    await mount(host, { initialQuery: "receipts source:alpha-mail" });
    expect(selectedLabels(host)).toEqual(["Alpha"]);
  });
});
