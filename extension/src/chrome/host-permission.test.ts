// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CAPTURE_ORIGINS,
  SCREENSHOT_ORIGINS,
  hasScreenshotPermission,
  requestScreenshotPermission,
  hasCapturePermission,
  needsCapturePermissionRepair,
  requestCapturePermission,
  revokeCapturePermission,
} from "./host-permission.js";
import { CAPTURE_CONTENT_SCRIPT } from "./content-registration.js";

describe("capture host permission", () => {
  it("requests exactly the configured HTTPS origins", async () => {
    const request = vi.fn(() => Promise.resolve(true));

    await requestCapturePermission(request);

    expect(request).toHaveBeenCalledExactlyOnceWith({ origins: CAPTURE_ORIGINS });
  });

  it("keeps requested origins, optional grants, and content-script matches in lockstep", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../public/manifest.json", import.meta.url), "utf8"),
    ) as {
      incognito: string;
      permissions: string[];
      optional_host_permissions: string[];
      content_scripts?: Array<{ matches: string[] }>;
    };

    expect(manifest.optional_host_permissions).toEqual([...CAPTURE_ORIGINS, ...SCREENSHOT_ORIGINS]);
    expect(manifest.incognito).toBe("not_allowed");
    expect(manifest.permissions).toContain("scripting");
    expect(manifest.content_scripts).toBeUndefined();
    expect(CAPTURE_CONTENT_SCRIPT.matches).toEqual(CAPTURE_ORIGINS);
  });

  it("does not let pairing claim success when the user declines", async () => {
    await expect(requestCapturePermission(() => Promise.resolve(false))).rejects.toThrow(
      /HTTPS page access was not granted/i,
    );
  });

  it("checks and removes the same capture grant", async () => {
    const getAll = vi.fn(() => Promise.resolve({ origins: [] }));
    const remove = vi.fn(() => Promise.resolve(true));

    await expect(hasCapturePermission(getAll)).resolves.toBe(false);
    await expect(revokeCapturePermission(remove)).resolves.toBe(true);
    expect(getAll).toHaveBeenCalledExactlyOnceWith();
    expect(remove).toHaveBeenNthCalledWith(1, { origins: SCREENSHOT_ORIGINS });
    expect(remove).toHaveBeenNthCalledWith(2, { origins: CAPTURE_ORIGINS });
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("uses Chrome's reported origin inventory for static content-script grants", async () => {
    await expect(
      hasCapturePermission(() => Promise.resolve({ origins: ["https://*/*"] })),
    ).resolves.toBe(true);
  });

  it("offers repair for paired upgrades and later permission revocation", () => {
    expect(needsCapturePermissionRepair(true, false)).toBe(true);
    expect(needsCapturePermissionRepair(true, true)).toBe(false);
    expect(needsCapturePermissionRepair(false, false)).toBe(false);
  });

  it("checks and asks for the screenshot grant separately from page capture", async () => {
    await expect(
      hasScreenshotPermission(() => Promise.resolve({ origins: ["https://*/*"] })),
    ).resolves.toBe(false);
    await expect(
      hasScreenshotPermission(() => Promise.resolve({ origins: ["https://*/*", "<all_urls>"] })),
    ).resolves.toBe(true);
    const request = vi.fn(() => Promise.resolve(false));
    await expect(requestScreenshotPermission(request)).resolves.toBe(false);
    expect(request).toHaveBeenCalledExactlyOnceWith({ origins: ["<all_urls>"] });
  });

  it("still removes the HTTPS grant when the screenshot grant cannot be removed", async () => {
    const remove = vi.fn((permissions: { origins?: string[] }) =>
      permissions.origins?.includes("<all_urls>")
        ? Promise.reject(new Error("not granted"))
        : Promise.resolve(true),
    );
    await expect(revokeCapturePermission(remove)).resolves.toBe(true);
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
