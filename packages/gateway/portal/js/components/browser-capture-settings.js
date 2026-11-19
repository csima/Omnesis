// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The capture settings every paired browser extension shares, on the Devices
// page beside the browsers themselves. The portal edits one of them here, the
// page-screenshot switch; exclusions and the pause are edited from the
// extension. Shown once a browser is paired: before that there is nothing to
// apply them to, and the gateway refuses the edit until a browser has paired.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getWebCapturePolicy, setWebCaptureScreenshots } from "../api.js";

/** Whether `devices` includes a paired, unrevoked browser extension. */
export function hasPairedBrowser(devices) {
  return Array.isArray(devices) && devices.some((d) => d?.kind === "browser" && !d?.revokedAt);
}

export function BrowserCaptureSettings() {
  const [policy, setPolicy] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    getWebCapturePolicy()
      .then((value) => live && setPolicy(value))
      .catch((e) => live && setError(String(e?.message || e)));
    return () => {
      live = false;
    };
  }, []);

  const unavailable = policy?.screenshots?.available === false;
  const enabled = policy?.screenshots?.enabled === true && !unavailable;

  async function toggle(event) {
    const next = event.currentTarget.checked;
    setSaving(true);
    setError(null);
    try {
      setPolicy(await setWebCaptureScreenshots(next));
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  return html`
    <section class="devices-group browser-capture-settings">
      <h2 class="devices-group-title">Browser capture</h2>
      <div class="browser-capture-card">
        <label class="browser-capture-toggle">
          <input
            type="checkbox"
            checked=${enabled}
            disabled=${policy === null || saving || unavailable}
            onChange=${toggle}
          />
          <span>Save a screenshot of each page</span>
        </label>
        <p class="devices-muted browser-capture-hint">
          Every paired browser also saves a screenshot of the visible part of each page it
          captures, shown as the page's preview. Screenshots are not redacted the way captured
          text is: whatever the page shows on screen is in the image. Each is deleted with its
          page. Off unless you turn it on; turning it off keeps the screenshots already saved.
        </p>
        ${unavailable &&
        html`<p class="devices-banner error" role="status">
          The preview store could not be opened, so this gateway keeps no screenshots and browsers
          take none. See the gateway log.
        </p>`}
        ${error && html`<p class="devices-banner error" role="alert">${error}</p>`}
      </div>
    </section>
  `;
}
