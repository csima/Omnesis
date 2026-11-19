// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import type { ToolHandle } from "@omnesis/agent";

/** What one permitted source holds and how complete its index is. */
export interface DirectSourceCoverage {
  sourceId: string;
  type: string;
  documentCount: number;
  earliestSourceDate: string | null;
  latestSourceDate: string | null;
  syncState: string | null;
  coverage: "complete" | "partial" | "unknown";
  lastSyncedAt: number | null;
}

const listSourcesArgsSchema = z.object({}).strict();

/** The callback supplies only this request's permitted sources, never a cached grant. */
export function createDirectListSourcesTool(
  sources: () => Promise<readonly DirectSourceCoverage[]>,
): ToolHandle {
  return {
    name: "list_sources",
    description:
      "List the sources this connection may read, with how many documents each holds, the " +
      "range of their dates, and whether the source's index is complete. Read-only metadata " +
      "without document content. A source marked `partial` or `unknown` cannot support claims " +
      "that something is absent from it.",
    schema: listSourcesArgsSchema,
    mutates: false,
    async invoke(rawArgs) {
      if (!listSourcesArgsSchema.safeParse(rawArgs).success) {
        return { kind: "error", code: "invalid_args", message: "list_sources takes no arguments." };
      }
      try {
        const listed = [...(await sources())].sort((a, b) =>
          a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0,
        );
        return {
          kind: "structured",
          resultType: "sources.coverage",
          data: { sources: listed },
        };
      } catch {
        return {
          kind: "error",
          code: "coverage_failed",
          message: "The source coverage could not be read.",
        };
      }
    },
  };
}
