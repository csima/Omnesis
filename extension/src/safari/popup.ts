// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "../chrome/chrome-api.js";
import { messageWithTimeout } from "../chrome/message-timeout.js";
import { CAPTURE_STATUS_MESSAGE, type CaptureContentStatus } from "../chrome/messages.js";
import { startPopup } from "./popup-view.js";
import type { SafariPopupAck } from "./messages.js";

const api = (globalThis as { browser?: typeof chrome }).browser ?? chrome;

/** A page that does not answer promptly is treated as having no script. */
const PAGE_ANSWER_TIMEOUT_MS = 1500;

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  return (await api.tabs.query({ active: true, currentWindow: true }))[0];
}

void startPopup({
  document,
  send: (message) => api.runtime.sendMessage<SafariPopupAck | undefined>(message),
  activePageUrl: async () => (await activeTab())?.url,
  pageCapture: async () => {
    const tabId = (await activeTab())?.id;
    if (tabId === undefined) return undefined;
    return messageWithTimeout(
      api.tabs.sendMessage<CaptureContentStatus | undefined>(tabId, CAPTURE_STATUS_MESSAGE),
      PAGE_ANSWER_TIMEOUT_MS,
    );
  },
  now: () => Date.now(),
});
