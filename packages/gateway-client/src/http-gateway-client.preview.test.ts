// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Preview uploads: what each gateway answer means to the uploader, and the
 * multipart request the client sends. The client never retries in-band, so
 * every case is one request.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { HttpGatewayClient, classifyPreviewUploadResponse } from "./http-gateway-client.js";

const upload = {
  providerId: "photos-synth:maya@example.com",
  sourceId: "photos-synth:maya@example.com",
  externalId: "album-1/att/a1b2c3",
  contentType: "image/jpeg" as const,
  width: 512,
  height: 384,
  capturedAt: "2026-03-04T08:12:00.000Z",
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifyPreviewUploadResponse", () => {
  test.each([
    [200, undefined, { outcome: "stored" }],
    [404, "PREVIEW_DOCUMENT_NOT_FOUND", { outcome: "not-found" }],
    [404, "NOT_FOUND", { outcome: "unsupported", code: "NOT_FOUND" }],
    [404, undefined, { outcome: "unsupported", code: undefined }],
    [409, "PREVIEWS_UNAVAILABLE", { outcome: "unsupported", code: "PREVIEWS_UNAVAILABLE" }],
    [409, "PREVIEWS_NOT_ACCEPTED", { outcome: "unsupported", code: "PREVIEWS_NOT_ACCEPTED" }],
    [409, "SOURCE_REJECTED", { outcome: "refused", status: 409, code: "SOURCE_REJECTED" }],
    [410, "PREVIEW_SUPPRESSED", { outcome: "refused", status: 410, code: "PREVIEW_SUPPRESSED" }],
    [400, "BAD_REQUEST", { outcome: "refused", status: 400, code: "BAD_REQUEST" }],
    [403, "FORBIDDEN", { outcome: "refused", status: 403, code: "FORBIDDEN" }],
    [413, "PAYLOAD_TOO_LARGE", { outcome: "refused", status: 413, code: "PAYLOAD_TOO_LARGE" }],
    [
      415,
      "UNSUPPORTED_PREVIEW_TYPE",
      { outcome: "refused", status: 415, code: "UNSUPPORTED_PREVIEW_TYPE" },
    ],
    [422, "PREVIEW_NOT_ALLOWED", { outcome: "refused", status: 422, code: "PREVIEW_NOT_ALLOWED" }],
  ] as const)("%i %s", (status, code, expected) => {
    expect(classifyPreviewUploadResponse(status, code)).toEqual(expected);
  });

  test.each([429, 503, 500, 502, 408])(
    "%i is transient and carries the gateway's wait",
    (status) => {
      expect(
        classifyPreviewUploadResponse(status, "PREVIEW_ADMISSION_PENDING", 5000),
      ).toMatchObject({ outcome: "transient", retryAfterMs: 5000 });
      expect(classifyPreviewUploadResponse(status, undefined)).not.toHaveProperty("retryAfterMs");
    },
  );
});

describe("HttpGatewayClient.putDocumentPreview", () => {
  test("sends one multipart PUT naming the document and carrying the image", async () => {
    const seen: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      seen.push(new Request(input as string, init));
      return Response.json({ stored: true });
    });
    const client = new HttpGatewayClient("https://gateway.example.com", "test-key");
    expect(await client.putDocumentPreview(upload)).toEqual({ outcome: "stored" });

    expect(seen).toHaveLength(1);
    const request = seen[0]!;
    expect(request.method).toBe("PUT");
    expect(new URL(request.url).pathname).toBe("/documents/preview");
    expect(request.headers.get("authorization")).toBe("Bearer test-key");
    const form = await request.formData();
    expect(form.get("externalId")).toBe(upload.externalId);
    expect(form.get("sourceId")).toBe(upload.sourceId);
    expect(form.get("width")).toBe("512");
    const image = form.get("image") as File;
    expect(image.type).toBe("image/jpeg");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(upload.bytes);
  });

  test("reads the code and Retry-After of a refusal, and sends nothing twice", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          { error: "not yet", code: "PREVIEW_ADMISSION_PENDING" },
          { status: 503, headers: { "Retry-After": "5" } },
        ),
      );
    const client = new HttpGatewayClient("https://gateway.example.com", "test-key");
    expect(await client.putDocumentPreview(upload)).toMatchObject({
      outcome: "transient",
      retryAfterMs: 5000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a network failure is transient, not a throw", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const client = new HttpGatewayClient("https://gateway.example.com", "test-key");
    expect(await client.putDocumentPreview(upload)).toMatchObject({ outcome: "transient" });
  });
});
