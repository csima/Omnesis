// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "../chrome/chrome-api.js";
import { startContentScript } from "../chrome/content-script.js";
import { SAFARI_SYNC_MESSAGE_TYPE } from "./messages.js";
import { safariHandoffStorage } from "./storage.js";

/**
 * Content-script entry for Safari: the same page glue the Chrome build runs,
 * over Safari's extension API. Safari injects it into the HTTPS pages the
 * person has allowed the extension on.
 */
const api = (globalThis as { browser?: typeof chrome }).browser ?? chrome;

startContentScript({
  document,
  window,
  location,
  chrome: {
    storage: {
      local: safariHandoffStorage(api.storage.local),
      onChanged: api.storage.onChanged,
    },
    runtime: api.runtime,
    extension: api.extension,
  },
  MutationObserver,
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
  now: () => Date.now(),
});

// The pairing lives in the app. Asking wakes the background, which mirrors it
// into storage; the glue above starts or stops on that storage change.
void api.runtime.sendMessage({ type: SAFARI_SYNC_MESSAGE_TYPE }).catch(() => undefined);
