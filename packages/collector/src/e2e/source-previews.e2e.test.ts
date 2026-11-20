// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Previews a collector's source declares, end to end over a real gateway.
 *
 * A source that makes preview images says so in its descriptor
 * (`documentPreviews`), and the gateway keeps an upload only from a collector
 * whose descriptors declare previews for the source's type. Pinned here, with
 * uploads sent through the real `HttpGatewayClient`: a declaring collector's
 * preview of an attachment document is stored, named on the document, on its
 * parent's attachment list and in search results, and served; a collector
 * whose descriptors do not declare previews is refused as unsupported; an
 * upload for a document not pushed yet is not-found; and deleting the
 * document removes its preview. All data is invented.
 */

import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GATEWAY_PREVIEW_STORE_FILE } from "@omnesis/core";
import {
  MultiCollectorHarness,
  waitForCondition,
  type PairedCollector,
} from "./multi-collector-harness.js";

const TYPE = "photos-synth";
const SOURCE = `${TYPE}:maya@example.com`;
const PARENT = "chat-1:2026-03-04";
const CHILD = `${PARENT}/att/a1b2c3d4e5f60718`;

/** A small baseline JPEG: SOI, a frame header naming 512×384, padding, EOI. */
function jpeg(): Uint8Array {
  const head = [
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x80, 0x02,
    0x00, 0x01, 0x01, 0x11, 0x00,
  ];
  const bytes = new Uint8Array(256);
  bytes.set(head, 0);
  bytes.set([0xff, 0xd9], bytes.length - 2);
  return bytes;
}

const preview = (externalId: string) => ({
  sourceId: SOURCE,
  externalId,
  contentType: "image/jpeg" as const,
  width: 512,
  height: 384,
  capturedAt: "2026-03-04T08:13:00.000Z",
  bytes: jpeg(),
});

function descriptor(documentPreviews: boolean): Record<string, unknown> {
  return {
    id: TYPE,
    name: "Photos (synthetic)",
    description: "synthetic photos",
    provider: { id: `${TYPE}-provider`, name: `${TYPE}-provider` },
    params: [],
    hasAuthFlow: false,
    hasDiscover: false,
    authType: "local",
    pushBased: true,
    singleInstance: false,
    ...(documentPreviews ? { documentPreviews: true } : {}),
  };
}

describe("previews a collector's source declares", () => {
  let harness: MultiCollectorHarness;
  let mac: PairedCollector;
  let linuxbox: PairedCollector;

  const documentIdOf = (externalId: string): string | undefined => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
        .get(externalId)?.id;
    } finally {
      db.close();
    }
  };
  const previewRows = (documentId: string): number => {
    const db = new Database(join(harness.gatewayConfigDir, GATEWAY_PREVIEW_STORE_FILE), {
      readonly: true,
    });
    try {
      return db
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM document_previews WHERE document_id = ?",
        )
        .get(documentId)!.n;
    } finally {
      db.close();
    }
  };
  const fetchAsAdmin = (path: string, init?: RequestInit) =>
    fetch(`${harness.gatewayUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${harness.bootstrapToken}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    mac = await harness.addCollector({
      name: "mac",
      hostableSourceTypes: [TYPE],
      descriptors: [descriptor(true)],
    });
    linuxbox = await harness.addCollector({
      name: "linuxbox",
      hostableSourceTypes: [TYPE],
      descriptors: [descriptor(false)],
    });
    const res = await fetch(`${mac.gatewayBase}/devices/sources/bulk-upsert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${mac.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [{ type: TYPE, accountId: "maya@example.com", enabled: true }],
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  test("an upload before the document is pushed is not-found", async () => {
    expect(await harness.uploadPreview(mac, preview(CHILD))).toEqual({ outcome: "not-found" });
  });

  test("a declaring collector's preview is stored and named wherever the document is", async () => {
    await harness.pushDocuments(mac, [
      {
        sourceId: SOURCE,
        externalId: PARENT,
        title: "Messages with Maya Reeves",
        content: "Maya Reeves: the marathon finish line photo is attached",
      },
      {
        sourceId: SOURCE,
        externalId: CHILD,
        title: "finish-line.heic",
        content: "Photo sent by Maya Reeves on 2026-03-04 at 08:12 from the marathon finish line",
        metadata: { extra: { parentExternalId: PARENT, mimeType: "image/heic" } },
      },
    ]);
    expect(await harness.uploadPreview(mac, preview(CHILD))).toEqual({ outcome: "stored" });

    const childId = documentIdOf(CHILD)!;
    const parentId = documentIdOf(PARENT)!;
    expect(previewRows(childId)).toBe(1);

    const served = await fetchAsAdmin(`/documents/${childId}/preview`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(jpeg());

    const expected = {
      url: `/documents/${childId}/preview`,
      contentType: "image/jpeg",
      width: 512,
      height: 384,
    };
    const shown = await harness.json<{ preview?: unknown }>(`/documents/${childId}`);
    expect(shown.preview).toMatchObject(expected);

    const { attachments } = await harness.json<{
      attachments: Array<{ id: string; preview?: unknown }>;
    }>(`/documents/${parentId}/attachments`);
    expect(attachments.find((a) => a.id === childId)?.preview).toMatchObject(expected);

    // Search results carry it once the document is indexed.
    let hit: { documentId: string; preview?: unknown } | undefined;
    await waitForCondition(
      async () => {
        const res = await fetchAsAdmin("/search", {
          method: "POST",
          body: JSON.stringify({ text: "marathon finish line photo", limit: 10 }),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as {
          results: Array<{ documentId: string; preview?: unknown }>;
        };
        hit = body.results.find((r) => r.documentId === childId);
        return hit !== undefined;
      },
      60_000,
      "the attachment document in search results",
    );
    expect(hit!.preview).toMatchObject(expected);
  });

  test("a collector whose descriptors do not declare previews is refused as unsupported", async () => {
    expect(await harness.uploadPreview(linuxbox, preview(CHILD))).toEqual({
      outcome: "unsupported",
      code: "PREVIEWS_NOT_ACCEPTED",
    });
  });

  test("deleting the document removes its preview", async () => {
    const childId = documentIdOf(CHILD)!;
    expect(previewRows(childId)).toBe(1);
    const res = await fetchAsAdmin(`/documents/${childId}`, { method: "DELETE" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(previewRows(childId)).toBe(0);
    expect((await fetchAsAdmin(`/documents/${childId}/preview`)).status).toBe(404);
  });
});
