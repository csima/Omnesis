// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Previews a collector's source declares it makes.
 *
 * A source that makes preview images for its documents says so in its
 * descriptor (`documentPreviews`), and the collector hosting it reports its
 * descriptors to the gateway when it connects. An upload is admitted here
 * when the device that sent it is a collector whose current descriptors
 * declare previews for the uploaded source's type. Nothing else about the
 * source matters to this rule, so no source is named in it.
 *
 * Until that collector's descriptors have arrived the answer is `pending`,
 * which the upload route turns into a retriable 503: the collector asks
 * again shortly rather than giving up on a preview it is entitled to. An
 * upload with no device behind it, from a device that is not a collector, or
 * for a source the gateway does not know, is `not-declared`.
 *
 * Only reads, each one an indexed row: nothing here touches the writer.
 */

import type { DeviceId } from "@omnesis/types";
import type Database from "better-sqlite3";
import type { CollectorDescriptorCache } from "../http/services/CollectorDescriptorCache.js";

type Db = Database.Database;

export type DeclaredPreviewVerdict = "accepted" | "not-declared" | "pending";

export interface DeclaredPreviewAdmission {
  check(sourceId: string, deviceId: DeviceId | null | undefined): Promise<DeclaredPreviewVerdict>;
}

export function createDeclaredPreviewAdmission(deps: {
  db: Db;
  descriptors: Pick<CollectorDescriptorCache, "descriptorsFor">;
}): DeclaredPreviewAdmission {
  return {
    async check(sourceId, deviceId) {
      if (!deviceId) return "not-declared";
      const type = deps.db
        .prepare<[string], { type: string }>("SELECT type FROM sources WHERE id = ?")
        .get(sourceId)?.type;
      if (!type) return "not-declared";
      const kind = deps.db
        .prepare<[string], { kind: string }>("SELECT kind FROM devices WHERE id = ?")
        .get(deviceId)?.kind;
      if (kind !== "collector") return "not-declared";
      const descriptors = await deps.descriptors.descriptorsFor(deviceId);
      if (!descriptors) return "pending";
      return descriptors.some((d) => d.id === type && d.documentPreviews === true)
        ? "accepted"
        : "not-declared";
    },
  };
}
