// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "../chrome/chrome-api.js";
import { startContentScript } from "../chrome/content-script.js";
import { createLocationWatcher } from "./location-watcher.js";
import { SAFARI_SYNC_MESSAGE_TYPE } from "./messages.js";
import { safariHandoffStorage } from "./storage.js";

/**
 * Content-script entry for Safari: the same page glue the Chrome build runs,
 * over Safari's extension API. Safari injects it into the HTTPS pages the
 * person has allowed the extension on.
 */
const api = (globalThis as { browser?: typeof chrome }).browser ?? chrome;

// Private Browsing is never read. Only an explicit "this is not a private
// tab" from Safari lets capture start; an API that cannot say is treated as
// a private tab.
const inPrivateBrowsing = api.extension?.inIncognitoContext !== false;

type PageWindow = Window & { navigation?: EventTarget };
const page = window as PageWindow;

startContentScript({
  document,
  window: {
    addEventListener: page.addEventListener.bind(page),
    removeEventListener: page.removeEventListener.bind(page),
    navigation:
      page.navigation ??
      createLocationWatcher({ location, setInterval: (fn, delayMs) => setInterval(fn, delayMs) }),
  },
  location,
  chrome: {
    storage: {
      local: safariHandoffStorage(api.storage.local),
      onChanged: api.storage.onChanged,
    },
    runtime: api.runtime,
    extension: { inIncognitoContext: inPrivateBrowsing },
  },
  MutationObserver,
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
  now: () => Date.now(),
});

// The pairing lives in the app. Asking wakes the background, which mirrors it
// into storage; the glue above starts when a pairing appears there and stops
// when it goes.
if (!inPrivateBrowsing) {
  void api.runtime.sendMessage({ type: SAFARI_SYNC_MESSAGE_TYPE }).catch(() => undefined);
}
