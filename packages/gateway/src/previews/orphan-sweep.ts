// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Remove previews whose document no longer exists.
 *
 * Every delete path removes its documents' previews as it goes; this is the
 * backstop for the ones a crash or a restart cut off between the document
 * delete and the preview delete, and for any path that removes documents
 * without naming them. It walks the preview store in id order a page at a
 * time, asks the document store which of the page's ids it still holds, and
 * deletes the rest, yielding between pages, so its cost is bounded by the
 * number of previews rather than the corpus and it never holds the event loop.
 */

import { createLogger } from "@omnesis/core";
import type { DocumentPreviewStore } from "./store.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("gateway").child("previews:sweep");

const PAGE = 500;

export async function sweepOrphanPreviews(db: Db, store: DocumentPreviewStore): Promise<number> {
  let after = "";
  let removed = 0;
  for (;;) {
    const ids = store.listDocumentIds(after, PAGE);
    if (ids.length === 0) break;
    const present = new Set(
      db
        .prepare<string[], { id: string }>(
          `SELECT id FROM documents WHERE id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(...ids)
        .map((row) => row.id),
    );
    const orphans = ids.filter((id) => !present.has(id));
    if (orphans.length > 0) removed += await store.deleteForDocuments(orphans);
    after = ids[ids.length - 1]!;
    if (ids.length < PAGE) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (removed > 0) log.info(`Removed ${removed} previews whose documents are gone`);
  return removed;
}

/** Run the sweep shortly after boot and then on `intervalMs`; returns the stop. */
export function scheduleOrphanPreviewSweep(
  db: Db,
  store: DocumentPreviewStore,
  opts: { firstDelayMs: number; intervalMs: number },
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = () => {
    void sweepOrphanPreviews(db, store)
      .catch((error: unknown) => {
        log.warn(
          `Orphan preview sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(run, opts.intervalMs);
          timer.unref();
        }
      });
  };
  timer = setTimeout(run, opts.firstDelayMs);
  timer.unref();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
