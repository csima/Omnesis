// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "../chrome/chrome-api.js";
import { createSafariBackground } from "./background.js";
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

const background = createSafariBackground({
  storage: api.storage.local,
  // Safari ignores the application name on iOS and always reaches the app
  // that contains this extension.
  sendNative: (message) => runtime.sendNativeMessage("application.id", message),
  alarms: api.alarms,
  runtimeId: runtime.id ?? "",
});

runtime.onMessage.addListener((message, sender, sendResponse) =>
  background.handleMessage(message, sender, sendResponse),
);
api.alarms.onAlarm.addListener((alarm) => background.handleAlarm(alarm.name));
void background.start();
