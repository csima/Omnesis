// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Document previews — one image per document, kept in the preview store.
 *
 *   - `PUT /documents/preview` stores the preview of a document the caller may
 *     write, named as its push names it (`providerId`, `sourceId`,
 *     `externalId`). A JSON body carries the image as base64 `image`; a
 *     multipart body carries it as the `image` part beside the same fields.
 *     `image/webp` or `image/jpeg`, at most 512 KB. 200 `{ stored, preview }`;
 *     409 when the source keeps no previews or refuses this one, 410 when the
 *     document was deleted for good, 404 when it does not exist (yet), 413 and
 *     415 for an image the store does not take.
 *   - `GET /documents/:id/preview` serves the image of a readable document with
 *     its content type, `Cache-Control: private` and an ETag; 404 when there
 *     is none.
 *
 * Without a preview store (it failed to open) both answer 503.
 */

import { bodyLimit } from "hono/body-limit";
import {
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "../errors.js";
import { scope } from "../scope.js";
import { previewUploadFields, previewUploadJsonBody } from "../schemas/index.js";
import { MAX_PREVIEW_BYTES } from "../../previews/store.js";
import type { DocumentPreviewService, PreviewUpload } from "../../previews/service.js";
import type { RouteApp } from "./types.js";

/** The base64 image plus the JSON framing and fields, or the multipart framing. */
const PREVIEW_BODY_LIMIT_BYTES = Math.ceil(MAX_PREVIEW_BYTES / 3) * 4 + 64 * 1024;

const previewBodyLimit = bodyLimit({
  maxSize: PREVIEW_BODY_LIMIT_BYTES,
  onError: (c) =>
    c.json(
      {
        error: `Preview too large (max ${MAX_PREVIEW_BYTES / 1024} KB)`,
        code: "PAYLOAD_TOO_LARGE",
      },
      413,
    ),
});

export function mountDocumentPreviewRoutes(
  app: RouteApp,
  previews: DocumentPreviewService | undefined,
): void {
  const service = (): DocumentPreviewService => {
    if (!previews) throw new ServiceUnavailableError("The preview store is not available");
    return previews;
  };

  app.put("/documents/preview", scope.writeAny(), previewBodyLimit, async (c) => {
    const previewService = service();
    const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
    const upload = contentType.startsWith("multipart/form-data")
      ? await readMultipart(c.req.raw)
      : await readJson(c.req.raw);
    const result = await previewService.upload(upload, c.get("auth"), new URL(c.req.url).hostname);
    return c.json(result);
  });

  app.get("/documents/:id/preview", scope.read(), (c) => {
    const preview = service().read(c.req.param("id"));
    if (!preview) throw new NotFoundError("No preview for this document");
    const headers = {
      "Content-Type": preview.meta.contentType,
      "Cache-Control": "private, max-age=0, must-revalidate",
      ETag: preview.meta.etag,
      "X-Content-Type-Options": "nosniff",
    };
    if (c.req.header("if-none-match") === preview.meta.etag) {
      return c.body(null, 304, headers);
    }
    return c.body(new Uint8Array(preview.bytes), 200, {
      ...headers,
      "Content-Length": String(preview.bytes.byteLength),
    });
  });
}

async function readJson(request: Request): Promise<PreviewUpload> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new BadRequestError("Malformed JSON in request body");
  }
  const parsed = previewUploadJsonBody.safeParse(raw);
  if (!parsed.success) throw new ValidationError("Validation failed", parsed.error.issues);
  const { image, ...fields } = parsed.data;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
    throw new BadRequestError("image must be base64");
  }
  return { ...fields, bytes: new Uint8Array(Buffer.from(image, "base64")) };
}

async function readMultipart(request: Request): Promise<PreviewUpload> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new BadRequestError("expected a multipart/form-data body");
  }
  const image = form.get("image");
  if (!(image instanceof File)) throw new BadRequestError("missing the image part");
  const fields = Object.fromEntries(
    [...form.entries()].filter(([key, value]) => key !== "image" && typeof value === "string"),
  );
  const parsed = previewUploadFields.safeParse({
    contentType: image.type || undefined,
    ...fields,
  });
  if (!parsed.success) throw new ValidationError("Validation failed", parsed.error.issues);
  return { ...parsed.data, bytes: new Uint8Array(await image.arrayBuffer()) };
}
