// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** How often the address is compared; a route change is seen well inside the dwell. */
export const LOCATION_POLL_MS = 1000;

export interface LocationWatcherDeps {
  location: Pick<Location, "href">;
  setInterval: (fn: () => void, delayMs: number) => unknown;
  pollMs?: number;
}

/**
 * A stand-in for the Navigation API's `navigation` object on a Safari that
 * has none: an event target that fires `currententrychange` when the page's
 * address has changed. A single-page site moves between articles with
 * `history.pushState`, which fires no event a content script can hear and
 * cannot be wrapped from its isolated world, so without this the next
 * article's text would be saved under the first one's address.
 */
export function createLocationWatcher(deps: LocationWatcherDeps): EventTarget {
  const target = new EventTarget();
  let last = deps.location.href;
  deps.setInterval(() => {
    const current = deps.location.href;
    if (current === last) return;
    last = current;
    target.dispatchEvent(new Event("currententrychange"));
  }, deps.pollMs ?? LOCATION_POLL_MS);
  return target;
}
