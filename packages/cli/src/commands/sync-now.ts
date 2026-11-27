// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { c, gatewayFetch, CliError, EXIT_USER_ERROR } from "../utils.js";

export interface SyncNowSourceLine {
  sourceId: string;
  outcome: string;
  syncedAt: string | null;
  lagMs: number | null;
  newItems: number;
  coalesced: boolean;
  cooledDown: boolean;
  message?: string;
}

export interface SyncNowResponse {
  ok: boolean;
  syncedAt: string | null;
  lagMs: number | null;
  newItems: number;
  coalesced: boolean;
  timedOut: boolean;
  elapsedMs: number;
  sourceIds: string[];
  unknown: string[];
  sources: SyncNowSourceLine[];
}

export function buildSyncNowBody(
  ids: readonly string[],
  type: string | undefined,
  timeoutSeconds: number | undefined,
): { sourceIds?: string[]; sourceType?: string; timeoutMs?: number } {
  return {
    ...(ids.length > 0 ? { sourceIds: [...ids] } : {}),
    ...(type ? { sourceType: type } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutMs: Math.round(timeoutSeconds * 1000) } : {}),
  };
}

export function renderSyncNow(res: SyncNowResponse): string[] {
  const lines: string[] = [];
  for (const s of res.sources) {
    const ok = s.outcome === "synced";
    const mark = ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    const tags = [
      s.coalesced ? (s.cooledDown ? "cooldown" : "joined in-flight sync") : "",
      s.newItems > 0 ? `+${s.newItems} new` : "",
      s.lagMs !== null ? `lag ${s.lagMs}ms` : "",
    ].filter(Boolean);
    const detail = ok ? "" : ` ${s.outcome}${s.message ? `: ${s.message}` : ""}`;
    lines.push(
      `${mark} ${c.bold}${s.sourceId}${c.reset}${detail}${tags.length ? ` ${c.dim}(${tags.join(", ")})${c.reset}` : ""}`,
    );
  }
  for (const u of res.unknown) lines.push(`${c.yellow}Unknown source:${c.reset} ${u}`);
  return lines;
}

export const syncNowCommand = defineCommand({
  meta: {
    name: "sync-now",
    description:
      "Refresh named sources, or every source of one type, right now and wait for the result",
  },
  args: {
    type: {
      type: "string",
      description: "Refresh every source of this type (for example gmail, quo, slack)",
    },
    timeout: {
      type: "string",
      description: "Max seconds to wait (1-60, default 20)",
      default: "20",
    },
    json: { type: "boolean", description: "Print the gateway's JSON answer", default: false },
  },
  async run(ctx) {
    const ids = ((ctx.args._ as string[]) ?? []).filter(Boolean);
    const type = typeof ctx.args.type === "string" && ctx.args.type ? ctx.args.type : undefined;
    if (ids.length === 0 && !type) {
      throw new CliError(
        `${c.red}Usage: omnesis sources sync-now <sourceId...> | --type <type> [--timeout <seconds>] [--json]${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const timeout = Number(ctx.args.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new CliError(
        `${c.red}--timeout must be a positive number of seconds (got "${ctx.args.timeout}")${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const res = await gatewayFetch("/admin/sync-now", {
      method: "POST",
      body: JSON.stringify(buildSyncNowBody(ids, type, timeout)),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new CliError(
        `${c.red}Sync failed: ${body.error ?? res.status}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const body = (await res.json()) as SyncNowResponse;
    if (ctx.args.json === true) console.log(JSON.stringify(body, null, 2));
    else for (const line of renderSyncNow(body)) console.log(line);
    if (!body.ok) throw new CliError("sync-now did not complete for every source", EXIT_USER_ERROR);
  },
});
