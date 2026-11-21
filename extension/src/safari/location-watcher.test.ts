// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { createLocationWatcher, LOCATION_POLL_MS } from "./location-watcher.js";

describe("createLocationWatcher", () => {
  function watch() {
    const location = { href: "https://news.example.org/a" };
    let tick: () => void = () => undefined;
    let delay = 0;
    const target = createLocationWatcher({
      location,
      setInterval: (fn, delayMs) => {
        tick = fn;
        delay = delayMs;
        return 1;
      },
    });
    let changes = 0;
    target.addEventListener("currententrychange", () => {
      changes += 1;
    });
    return { location, tick: () => tick(), delay: () => delay, changes: () => changes };
  }

  it("says nothing while the address stays the same", () => {
    const page = watch();
    page.tick();
    page.tick();
    expect(page.changes()).toBe(0);
    expect(page.delay()).toBe(LOCATION_POLL_MS);
  });

  it("fires once for each change of address, however the page made it", () => {
    const page = watch();
    page.location.href = "https://news.example.org/b";
    page.tick();
    page.tick();
    expect(page.changes()).toBe(1);
    page.location.href = "https://news.example.org/b#comments";
    page.tick();
    expect(page.changes()).toBe(2);
    page.location.href = "https://news.example.org/a";
    page.tick();
    expect(page.changes()).toBe(3);
  });
});
