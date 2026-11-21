// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The files a document carries, as a row of tiles above its text: each
// attachment child's preview thumbnail (or a placeholder for its file type)
// with its filename. A tile opens the original where the source keeps it —
// the child's `sourceUrl` — and a small link under it opens the child's own
// document page. A child with no link to its original opens its page instead.

import { html } from "htm/preact";
import { isOpenableExternalUrl } from "../lib/format.js";
import { FileTypeIcon } from "../lib/file-type-icons.js";
import { navigate } from "../lib/router.js";
import { PreviewThumbnail } from "./document-preview.js";

/** The in-portal page of one document. */
export function documentPageHref(id) {
  return `/portal/doc/${encodeURIComponent(id)}`;
}

/**
 * Where a tile opens, and how. The original when the child links to one; a
 * web address opens in a new tab, any other scheme is handed to the app that
 * owns it in place (a new tab would be left blank). Without a link, the
 * child's document page, navigated inside the portal.
 */
export function attachmentTileTarget(child) {
  const url = child?.sourceUrl;
  if (isOpenableExternalUrl(url)) {
    const web = /^https?:/i.test(url);
    return { href: url, original: true, newTab: web };
  }
  return { href: documentPageHref(child.id), original: false, newTab: false };
}

function attachmentName(child) {
  return child.title || "Untitled attachment";
}

function OpenPageIcon() {
  return html`<svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9.5 1.5H4A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V5.5z"/>
    <path d="M9.5 1.5v4h4"/>
    <path d="M5.5 9h5M5.5 11.5h3"/>
  </svg>`;
}

function inPortal(href) {
  return (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(href);
  };
}

function AttachmentTile({ child }) {
  const name = attachmentName(child);
  const target = attachmentTileTarget(child);
  const pageHref = documentPageHref(child.id);
  const openLabel = target.original ? `Open the original of ${name}` : `Open ${name}`;
  const placeholder = html`<span class="att-tile-placeholder">
    <${FileTypeIcon} mimeType=${child.mimeType} filename=${name} size=${28} />
  </span>`;
  return html`
    <li class="att-tile">
      <a
        class="att-tile-open"
        href=${target.href}
        target=${target.newTab ? "_blank" : undefined}
        rel=${target.newTab ? "noopener" : undefined}
        title=${openLabel}
        aria-label=${openLabel}
        onClick=${target.original ? undefined : inPortal(target.href)}
      >
        <span class="att-tile-thumb">
          <${PreviewThumbnail}
            preview=${child.preview}
            alt=${name}
            className="att-tile-image"
            fallback=${placeholder}
          />
        </span>
        <span class="att-tile-name">${name}</span>
      </a>
      ${target.original && html`<a
        class="att-tile-page"
        href=${pageHref}
        title="Open this attachment's document page"
        aria-label=${`Document page for ${name}`}
        onClick=${inPortal(pageHref)}
      ><${OpenPageIcon} /></a>`}
    </li>
  `;
}

/**
 * The children in the order the parent lists its files (its attachment
 * markers, matched by `attachmentId`), which is the order they were sent;
 * a child no marker names keeps its place after them.
 */
export function orderAttachments(children, attachmentInfos) {
  const rank = new Map();
  (attachmentInfos ?? []).forEach((info, index) => {
    if (info?.attachmentId && !rank.has(info.attachmentId)) rank.set(info.attachmentId, index);
  });
  if (rank.size === 0) return children;
  const at = (child) => rank.get(child.attachmentId) ?? Number.MAX_SAFE_INTEGER;
  return children
    .map((child, index) => ({ child, index }))
    .sort((a, b) => at(a.child) - at(b.child) || a.index - b.index)
    .map(({ child }) => child);
}

export function AttachmentStrip({ attachments, attachmentInfos }) {
  const children = orderAttachments(
    (attachments ?? []).filter((child) => child && child.id),
    attachmentInfos,
  );
  if (children.length === 0) return null;
  return html`
    <section class="att-strip" aria-label="Attachments">
      <ul class="att-strip-list">
        ${children.map((child) => html`<${AttachmentTile} key=${child.id} child=${child} />`)}
      </ul>
    </section>
  `;
}
