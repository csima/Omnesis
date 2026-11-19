// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// A document's preview image — any source may give a document one; the
// gateway serves it at `preview.url` beside the document. Shown above the
// document's text when present, at its natural aspect ratio, never wider than
// the content column.

import { html } from "htm/preact";
import { timeAgo } from "../lib/format.js";

/**
 * The image address of a document's `preview`, or null when there is none or
 * it does not point at a gateway document preview. Only a same-origin
 * `/documents/<id>/preview` path is used: the field arrives from the API and
 * an `<img src>` must never be pointed anywhere else by it.
 */
export function previewSrc(preview) {
  const url = preview?.url;
  if (typeof url !== "string") return null;
  return /^\/documents\/[^/?#]+\/preview$/.test(url) ? url : null;
}

export function DocumentPreview({ preview, title }) {
  const src = previewSrc(preview);
  if (!src) return null;
  const width = Number.isInteger(preview.width) && preview.width > 0 ? preview.width : undefined;
  const height = Number.isInteger(preview.height) && preview.height > 0 ? preview.height : undefined;
  return html`
    <figure class="doc-preview">
      <img
        class="doc-preview-image"
        src=${src}
        width=${width}
        height=${height}
        alt=${`Preview of ${title || "this document"}`}
        loading="lazy"
        decoding="async"
      />
      ${preview.capturedAt &&
      html`<figcaption class="doc-preview-caption">Preview captured ${timeAgo(preview.capturedAt)}</figcaption>`}
    </figure>
  `;
}
