// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { SyncError } from "@omnesis/types";
import { z } from "zod";
import { tsSchema, workspaceUrl } from "./types.js";
import type { Credential } from "./types.js";

const READ_METHODS: ReadonlySet<string> = new Set([
  "auth.test",
  "users.conversations",
  "conversations.info",
  "conversations.history",
  "conversations.replies",
  "users.list",
  "usergroups.list",
  "client.counts",
]);
const TIER_2: ReadonlySet<string> = new Set([
  "users.list",
  "users.conversations",
  "usergroups.list",
]);
const TIER_2_GAP_MS = 3000;
const TIER_3_GAP_MS = 1200;
const envelope = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
    response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
  })
  .passthrough();
export const AUTH_REMEDIATION = {
  summary: "Slack needs a fresh sign-in",
  steps: [
    "Sign in again in Slack or Chrome for session mode, or reconnect the official user token. History already indexed is kept.",
  ],
  restartRequired: false,
};

export class SlackClient {
  private readonly nextAt = new Map<string, number>();
  private readonly replay = new Map<string, Record<string, unknown>>();
  constructor(
    private readonly credential: Credential,
    private readonly options: {
      fetchImpl?: typeof fetch;
      now?: () => number;
      pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
      paceMs?: number;
    } = {},
  ) {
    workspaceUrl(credential.identity.url);
  }

  /** Forget the responses kept for a retry once the page that read them has committed. */
  settle(): void {
    this.replay.clear();
  }

  async call(
    method: string,
    params: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    // This check precedes URL construction, pacing and the transport seam.
    if (!READ_METHODS.has(method))
      throw new SyncError("permission", "Slack method is not read-only");
    for (const key of ["oldest", "latest"])
      if (params[key] !== undefined) tsSchema.parse(params[key]);
    signal?.throwIfAborted();
    const key = `${method}?${new URLSearchParams(params).toString()}`;
    const kept = this.replay.get(key);
    if (kept) return kept;
    const now = this.options.now ?? Date.now;
    const wait = Math.max(0, (this.nextAt.get(method) ?? 0) - now());
    if (wait) await (this.options.pause ?? pause)(wait, signal);
    // Slack budgets each method separately: Tier 2 ~20/min, Tier 3 ~50/min. 429s leave retry to the scheduler.
    this.nextAt.set(
      method,
      now() + (this.options.paceMs ?? (TIER_2.has(method) ? TIER_2_GAP_MS : TIER_3_GAP_MS)),
    );
    const host = this.credential.cookie
      ? workspaceUrl(this.credential.identity.url)
      : "https://slack.com/";
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(`${host}api/${method}`, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${this.credential.token}`,
          ...(this.credential.cookie
            ? { Cookie: `d=${this.credential.cookie}`, "User-Agent": this.credential.userAgent! }
            : {}),
        },
        body: new URLSearchParams(params),
      });
    } catch {
      signal?.throwIfAborted();
      // Do not attach the transport error: it can contain request headers.
      throw new SyncError("network", "Slack request failed; retry on the next cycle");
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get("Retry-After"));
      throw new SyncError("rate-limit", "Slack rate limit; waiting before the next attempt", {
        retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000,
        quota: { kind: "account" },
      });
    }
    if (response.status === 401)
      throw new SyncError("auth", "Slack sign-in expired", { remediation: AUTH_REMEDIATION });
    if (response.status === 403) throw new SyncError("permission", "Slack denied read access");
    if (!response.ok) throw new SyncError("transient", "Slack is temporarily unavailable");
    let data: z.infer<typeof envelope>;
    try {
      data = envelope.parse(await response.json());
    } catch {
      throw new SyncError("transient", "Slack returned an invalid response");
    }
    if (!data.ok) {
      if (
        [
          "invalid_auth",
          "not_authed",
          "token_revoked",
          "account_inactive",
          "session_expired",
        ].includes(data.error ?? "")
      )
        throw new SyncError("auth", "Slack sign-in expired", { remediation: AUTH_REMEDIATION });
      if (
        [
          "missing_scope",
          "not_in_channel",
          "channel_not_found",
          "access_denied",
          "user_is_restricted",
          "paid_teams_only",
        ].includes(data.error ?? "")
      )
        throw new SyncError(
          "permission",
          "Slack cannot read this conversation with the current grant",
          { scope: method.startsWith("conversations.") ? "partition" : "source" },
        );
      const code = /^[a-z0-9_]{1,64}$/.test(data.error ?? "")
        ? data.error
        : "an unrecognized error";
      throw new SyncError(
        "transient",
        `Slack could not complete this read: ${method} returned ${code}`,
      );
    }
    this.replay.set(key, data);
    return data;
  }

  async list(
    method: string,
    field: string,
    params: Record<string, string> = {},
    signal?: AbortSignal,
    enough?: (page: unknown[]) => boolean,
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    const seen = new Set<string>();
    let cursor = "";
    for (let page = 0; page < 10_000; page++) {
      const data = await this.call(
        method,
        { ...params, limit: "200", ...(cursor ? { cursor } : {}) },
        signal,
      );
      if (!Array.isArray(data[field]))
        throw new SyncError("transient", "Slack returned an incomplete listing");
      out.push(...data[field]);
      if (enough?.(data[field])) return out;
      const meta = data.response_metadata as { next_cursor?: string } | undefined;
      const next = meta?.next_cursor?.trim() ?? "";
      if (!next) {
        if (data.has_more === true)
          throw new SyncError(
            "transient",
            "Slack pagination ended before the listing was complete",
          );
        return out;
      }
      if (seen.has(next)) throw new SyncError("transient", "Slack repeated a pagination cursor");
      seen.add(next);
      cursor = next;
    }
    throw new SyncError(
      "transient",
      "Slack listing exceeded its safety bound; no checkpoint advanced",
    );
  }
}
async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  const { setTimeout } = await import("node:timers/promises");
  await setTimeout(ms, undefined, { signal });
}
