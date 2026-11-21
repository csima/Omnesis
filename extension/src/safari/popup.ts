// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "../chrome/chrome-api.js";
import { startPopup } from "./popup-view.js";
import type { SafariPopupAck } from "./messages.js";

const api = (globalThis as { browser?: typeof chrome }).browser ?? chrome;

void startPopup({
  document,
  send: (message) => api.runtime.sendMessage<SafariPopupAck | undefined>(message),
  activePageUrl: async () => (await api.tabs.query({ active: true, currentWindow: true }))[0]?.url,
  now: () => Date.now(),
});
