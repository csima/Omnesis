// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "../chrome/chrome-api.js";
import { createSafariBackground } from "./background.js";
import { safariScreenshotBrowser, safariScreenshotCodec } from "./screenshot.js";
import type { NativeMessage } from "./native-bridge.js";

/**
 * Background entry for Safari on iPhone and iPad. Safari stops this script
 * within a minute of its last event, so everything it must remember lives in
 * `storage.local` and every wake starts from there.
 */
type SafariRuntime = typeof chrome.runtime & {
  sendNativeMessage(application: string, message: NativeMessage): Promise<unknown>;
};

const api = (globalThis as { browser?: typeof chrome }).browser ?? chrome;
const runtime = api.runtime as SafariRuntime;

const codec = safariScreenshotCodec();

const background = createSafariBackground({
  storage: api.storage.local,
  // Safari ignores the application name on iOS and always reaches the app
  // that contains this extension.
  sendNative: (message) => runtime.sendNativeMessage("application.id", message),
  alarms: api.alarms,
  runtimeId: runtime.id ?? "",
  popupUrl: runtime.getURL("popup.html"),
  ...(codec
    ? {
        screenshots: {
          browser: safariScreenshotBrowser(api),
          codec,
          askPage: (tabId: number, message: unknown) => api.tabs.sendMessage(tabId, message),
          // Tab ids name tabs of this browser session only.
          pending: api.storage.session ?? api.storage.local,
        },
      }
    : {}),
});

runtime.onMessage.addListener((message, sender, sendResponse) =>
  background.handleMessage(message, sender, sendResponse),
);
api.alarms.onAlarm.addListener((alarm) => background.handleAlarm(alarm.name));

// A screenshot missed while its tab was out of view is tried again when the
// tab comes back; a navigation or a closed tab drops it.
const quietly = (work: Promise<unknown>): void => void work.catch(() => undefined);
api.tabs.onActivated?.addListener(({ tabId }) => quietly(background.tabInView(tabId)));
api.windows?.onFocusChanged?.addListener((windowId) => {
  if (windowId === api.windows.WINDOW_ID_NONE) return;
  quietly(
    api.tabs
      .query({ active: true, windowId })
      .then(([tab]) => (tab?.id !== undefined ? background.tabInView(tab.id) : "idle")),
  );
});
api.tabs.onUpdated?.addListener((tabId, change) => {
  if (change.url !== undefined) quietly(background.tabNavigated(tabId, change.url));
});
api.tabs.onRemoved?.addListener((tabId) => quietly(background.tabClosed(tabId)));
void background.start().catch(() => undefined);
