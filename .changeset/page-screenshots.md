---
"omnesis": patch
---

The browser extension can save a screenshot of each page it captures, shown as the page's preview in the portal and the apps. It is off by default; one shared setting, on the extension's Options page and popup or in the portal under Settings → Devices, turns it on for every paired browser. The shot is the visible part of the page only, taken after the same five-second dwell while the tab is the active tab of a focused window, downscaled to at most 1280 pixels and kept under 512 KB. Screenshots are not redacted the way captured text is. Chrome allows an extension screenshots only with access to all sites, so turning them on asks Chrome for that optional permission in each browser. The gateway keeps one preview per document in its own encrypted store (`previews.db`), includes it in backups and exports, and deletes it with its document on every delete path. Documents and search results carry an optional `preview` reference to `GET /documents/<id>/preview`.
