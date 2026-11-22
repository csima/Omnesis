// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Safari build's browser-free core, for suites that drive it under Node
 * against a real gateway.
 */
export {
  createSafariBackground,
  SAFARI_DRAIN_ALARM,
  SAFARI_GATEWAY_HOST_KEY,
  SAFARI_PROFILE_LABEL,
} from "./background.js";
export type { SafariBackground, SafariBackgroundDeps, SafariMessageSender } from "./background.js";
export type { SafariPopupAck, SafariPopupMessage, SafariStatus } from "./messages.js";
export { isAllowedNativeRequest } from "./native-contract.js";
export { SAFARI_GATEWAY_ORIGIN } from "./native-bridge.js";
export type {
  NativeMessage,
  NativeResponse,
  NativeStatus,
  SendNativeMessage,
} from "./native-bridge.js";
export type { SafariStorageArea } from "./storage.js";
