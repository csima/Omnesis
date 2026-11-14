// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Request-body schemas for the routes mounted in `routes/document-previews.ts`. */
import { z } from "zod";

/** Base64 of the largest preview image, with room for padding. */
const MAX_PREVIEW_BASE64_CHARS = Math.ceil((512 * 1024) / 3) * 4;

/**
 * The fields of `PUT /documents/preview`. The target document is named the way
 * a push client names it when it pushes the document; `streamId` is never sent
 * — the stream is the caller's own. In a JSON body `image` is the image's
 * base64; in a multipart body the image is the `image` part and the other
 * fields are form fields.
 */
export const previewUploadFields = z.object({
  providerId: z.string().min(1).max(256),
  sourceId: z.string().min(1).max(256),
  externalId: z.string().min(1).max(1024),
  contentType: z.string().min(1).max(64),
  width: z.coerce.number().int(),
  height: z.coerce.number().int(),
  capturedAt: z.string().datetime({ offset: true }),
});

export const previewUploadJsonBody = previewUploadFields.extend({
  image: z.string().min(1).max(MAX_PREVIEW_BASE64_CHARS),
});
