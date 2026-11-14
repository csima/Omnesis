// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** HTTPS access is optional at install time and requested when the user pairs. */
export const CAPTURE_ORIGINS = ["https://*/*"];

/**
 * Page screenshots need more than the HTTPS grant: Chrome lets
 * `chrome.tabs.captureVisibleTab` run only with `<all_urls>` or an
 * `activeTab` invocation, and a screenshot taken at the end of a dwell has no
 * invocation. So this optional grant is asked for in each browser, from the
 * screenshot switch, only when the user turns screenshots on there.
 */
export const SCREENSHOT_ORIGINS = ["<all_urls>"];

export function needsCapturePermissionRepair(paired: boolean, granted: boolean): boolean {
  return paired && !granted;
}

type RequestPermission = (permissions: chrome.permissions.Permissions) => Promise<boolean>;
type GetPermissions = () => Promise<chrome.permissions.Permissions>;
type RemovePermission = (permissions: chrome.permissions.Permissions) => Promise<boolean>;

export function hasCapturePermission(
  getAll: GetPermissions = () => chrome.permissions.getAll(),
): Promise<boolean> {
  return getAll().then((permissions) =>
    CAPTURE_ORIGINS.every((origin) => permissions.origins?.includes(origin) === true),
  );
}

/** Require Chrome's explicit host grant before pairing can claim capture is ready. */
export async function requestCapturePermission(
  request: RequestPermission = (permissions) => chrome.permissions.request(permissions),
): Promise<void> {
  const granted = await request({ origins: CAPTURE_ORIGINS });
  if (!granted) {
    throw new Error(
      "HTTPS page access was not granted. Omnesis needs this permission to capture pages you read.",
    );
  }
}

/** Whether this browser granted the screenshot permission. */
export function hasScreenshotPermission(
  getAll: GetPermissions = () => chrome.permissions.getAll(),
): Promise<boolean> {
  return getAll().then((permissions) =>
    SCREENSHOT_ORIGINS.every((origin) => permissions.origins?.includes(origin) === true),
  );
}

/** Ask Chrome for the screenshot permission; must run inside the user's click. */
export function requestScreenshotPermission(
  request: RequestPermission = (permissions) => chrome.permissions.request(permissions),
): Promise<boolean> {
  return request({ origins: SCREENSHOT_ORIGINS });
}

/**
 * Relinquish page access after capture is explicitly unpaired: the
 * screenshot grant, which covers every page, first, then the HTTPS grant,
 * whose result is the answer.
 */
export async function revokeCapturePermission(
  remove: RemovePermission = (permissions) => chrome.permissions.remove(permissions),
): Promise<boolean> {
  try {
    await remove({ origins: SCREENSHOT_ORIGINS });
  } catch {
    // Never granted, or already gone; the HTTPS grant below is what matters.
  }
  return remove({ origins: CAPTURE_ORIGINS });
}
