// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Targeted, bounded, on-demand sync for the sources whose newest item cannot
 * wait for the next scheduled tick (a verification code, a sign-in link, a
 * live message).
 *
 * Concurrent callers for one source share a single in-flight sync instead of
 * each triggering their own, and a source that finished a sync-now moments ago
 * is answered from that run instead of being hit again. A caller's `timeoutMs`
 * bounds only how long that caller waits: the sync it joined keeps running to
 * its own hard cap, so a slow caller never cancels a fast one's result.
 */

export const SYNC_NOW_DEFAULT_TIMEOUT_MS = 20_000;
export const SYNC_NOW_MIN_TIMEOUT_MS = 1_000;
export const SYNC_NOW_MAX_TIMEOUT_MS = 60_000;
export const SYNC_NOW_DEFAULT_COOLDOWN_MS = 5_000;
export const SYNC_NOW_DEFAULT_POLL_MS = 500;
export const SYNC_NOW_DEFAULT_FLIGHT_CAP_MS = 90_000;

export type SyncNowOutcome =
  "synced" | "timeout" | "error" | "needs-auth" | "rate-limited" | "paused" | "dispatch-failed";

export interface SyncNowSource {
  id: string;
  type: string;
  enabled: boolean;
}

export interface SyncNowStatus {
  state: string;
  lastSyncAt: string | null;
  erroredAt?: string;
  errorMessage?: string;
}

export interface SyncNowDispatchResult {
  ok: boolean;
  triggered?: number;
  skipped?: number;
  error?: string;
}

export interface SyncNowPorts {
  listSources(): readonly SyncNowSource[];
  status(sourceId: string): SyncNowStatus | null;
  documentCount(sourceId: string): number;
  dispatch(sourceId: string): Promise<SyncNowDispatchResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncNowOptions {
  cooldownMs?: number;
  pollMs?: number;
  flightCapMs?: number;
}

export interface SyncNowRequest {
  sourceIds?: readonly string[];
  sourceType?: string;
  timeoutMs?: number;
}

export interface SyncNowSourceResult {
  sourceId: string;
  outcome: SyncNowOutcome;
  syncedAt: string | null;
  lagMs: number | null;
  newItems: number;
  coalesced: boolean;
  cooledDown: boolean;
  message?: string;
}

export interface SyncNowResult {
  ok: boolean;
  syncedAt: string | null;
  lagMs: number | null;
  newItems: number;
  coalesced: boolean;
  timedOut: boolean;
  elapsedMs: number;
  sourceIds: string[];
  unknown: string[];
  sources: SyncNowSourceResult[];
}

export class SyncNowUnknownSourceError extends Error {
  constructor(readonly unknown: readonly string[]) {
    super(
      unknown.length > 0
        ? `unknown source: ${unknown.join(", ")}`
        : "no source matched the request",
    );
    this.name = "SyncNowUnknownSourceError";
  }
}

export class SyncNowBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncNowBadRequestError";
  }
}

export function clampSyncNowTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return SYNC_NOW_DEFAULT_TIMEOUT_MS;
  return Math.min(
    SYNC_NOW_MAX_TIMEOUT_MS,
    Math.max(SYNC_NOW_MIN_TIMEOUT_MS, Math.floor(timeoutMs)),
  );
}

interface FlightResult {
  outcome: Exclude<SyncNowOutcome, "timeout">;
  syncedAt: string | null;
  newItems: number;
  finishedAt: number;
  message?: string;
}

const ERROR_STATES: ReadonlyMap<string, Exclude<SyncNowOutcome, "timeout">> = new Map([
  ["error", "error"],
  ["needs-auth", "needs-auth"],
  ["rate-limited", "rate-limited"],
]);

export class SyncNowCoordinator {
  private readonly flights = new Map<string, Promise<FlightResult>>();
  private readonly recent = new Map<string, FlightResult>();
  private readonly cooldownMs: number;
  private readonly pollMs: number;
  private readonly flightCapMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly ports: SyncNowPorts,
    opts: SyncNowOptions = {},
  ) {
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? SYNC_NOW_DEFAULT_COOLDOWN_MS);
    this.pollMs = Math.max(1, opts.pollMs ?? SYNC_NOW_DEFAULT_POLL_MS);
    this.flightCapMs = Math.max(1, opts.flightCapMs ?? SYNC_NOW_DEFAULT_FLIGHT_CAP_MS);
    this.now = ports.now ?? Date.now;
    this.sleep = ports.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  resolveTargets(req: SyncNowRequest): { ids: string[]; unknown: string[] } {
    const hasIds = (req.sourceIds?.length ?? 0) > 0;
    const type = req.sourceType?.trim();
    if (!hasIds && !type) {
      throw new SyncNowBadRequestError("pass sourceIds or sourceType");
    }
    const sources = this.ports.listSources();
    const byId = new Map(sources.map((s) => [s.id, s]));
    const ids = new Set<string>();
    const unknown: string[] = [];
    for (const id of req.sourceIds ?? []) {
      if (byId.has(id)) ids.add(id);
      else unknown.push(id);
    }
    if (type) {
      const matched = sources.filter((s) => s.type === type);
      if (matched.length === 0 && !hasIds) throw new SyncNowUnknownSourceError([type]);
      for (const s of matched) ids.add(s.id);
    }
    if (ids.size === 0) throw new SyncNowUnknownSourceError(unknown);
    return { ids: [...ids].sort(), unknown };
  }

  async syncNow(req: SyncNowRequest): Promise<SyncNowResult> {
    const startedAt = this.now();
    const timeoutMs = clampSyncNowTimeout(req.timeoutMs);
    const { ids, unknown } = this.resolveTargets(req);
    const enabled = new Map(this.ports.listSources().map((s) => [s.id, s.enabled]));

    const deadline = this.sleep(timeoutMs).then(() => "timeout" as const);
    const sources = await Promise.all(
      ids.map(async (id): Promise<SyncNowSourceResult> => {
        if (enabled.get(id) === false) {
          return {
            sourceId: id,
            outcome: "paused",
            syncedAt: this.ports.status(id)?.lastSyncAt ?? null,
            lagMs: null,
            newItems: 0,
            coalesced: false,
            cooledDown: false,
            message: "source is paused",
          };
        }
        const { flight, coalesced, cooledDown } = this.join(id);
        const raced = await Promise.race([flight, deadline]);
        if (raced === "timeout") {
          const syncedAt = this.ports.status(id)?.lastSyncAt ?? null;
          return {
            sourceId: id,
            outcome: "timeout",
            syncedAt,
            lagMs: this.lag(syncedAt),
            newItems: 0,
            coalesced,
            cooledDown,
            message: `still syncing after ${timeoutMs}ms; the sync continues in the background`,
          };
        }
        return {
          sourceId: id,
          outcome: raced.outcome,
          syncedAt: raced.syncedAt,
          lagMs: this.lag(raced.syncedAt),
          newItems: raced.newItems,
          coalesced,
          cooledDown,
          ...(raced.message ? { message: raced.message } : {}),
        };
      }),
    );

    const synced = sources.filter((s) => s.syncedAt !== null);
    const oldest = synced.length
      ? synced.reduce((a, b) => (Date.parse(a.syncedAt!) <= Date.parse(b.syncedAt!) ? a : b))
      : null;
    return {
      ok: sources.every((s) => s.outcome === "synced"),
      syncedAt: oldest?.syncedAt ?? null,
      lagMs: oldest ? this.lag(oldest.syncedAt) : null,
      newItems: sources.reduce((n, s) => n + s.newItems, 0),
      coalesced: sources.some((s) => s.coalesced),
      timedOut: sources.some((s) => s.outcome === "timeout"),
      elapsedMs: this.now() - startedAt,
      sourceIds: ids,
      unknown,
      sources,
    };
  }

  private lag(syncedAt: string | null): number | null {
    if (!syncedAt) return null;
    const t = Date.parse(syncedAt);
    return Number.isFinite(t) ? Math.max(0, this.now() - t) : null;
  }

  private join(id: string): {
    flight: Promise<FlightResult>;
    coalesced: boolean;
    cooledDown: boolean;
  } {
    const inFlight = this.flights.get(id);
    if (inFlight) return { flight: inFlight, coalesced: true, cooledDown: false };
    const last = this.recent.get(id);
    if (last && this.now() - last.finishedAt < this.cooldownMs) {
      return { flight: Promise.resolve(last), coalesced: true, cooledDown: true };
    }
    const flight = this.run(id).finally(() => {
      this.flights.delete(id);
    });
    this.flights.set(id, flight);
    return { flight, coalesced: false, cooledDown: false };
  }

  private async run(id: string): Promise<FlightResult> {
    const startedAt = this.now();
    const before = this.ports.status(id);
    const docsBefore = this.ports.documentCount(id);
    const finish = (outcome: FlightResult["outcome"], message?: string): FlightResult => {
      const syncedAt = this.ports.status(id)?.lastSyncAt ?? null;
      const result: FlightResult = {
        outcome,
        syncedAt,
        newItems: Math.max(0, this.ports.documentCount(id) - docsBefore),
        finishedAt: this.now(),
        ...(message ? { message } : {}),
      };
      if (outcome === "synced" || ERROR_STATES.has(outcome)) this.recent.set(id, result);
      return result;
    };

    let dispatched: SyncNowDispatchResult;
    try {
      dispatched = await this.ports.dispatch(id);
    } catch (err) {
      return finish("dispatch-failed", err instanceof Error ? err.message : String(err));
    }
    if (!dispatched.ok) return finish("dispatch-failed", dispatched.error ?? "sync was rejected");

    let seenSyncing = false;
    while (this.now() - startedAt < this.flightCapMs) {
      const st = this.ports.status(id);
      if (st) {
        if (st.state === "syncing") seenSyncing = true;
        else {
          const advanced = st.lastSyncAt !== (before?.lastSyncAt ?? null);
          const errored = ERROR_STATES.get(st.state);
          const freshError =
            errored !== undefined && (seenSyncing || st.erroredAt !== before?.erroredAt);
          if (freshError) return finish(errored, st.errorMessage);
          if (st.state === "paused") return finish("paused", "source is paused");
          if (advanced || (seenSyncing && !errored)) return finish("synced");
        }
      }
      await this.sleep(this.pollMs);
    }
    return finish("error", `no completion observed within ${this.flightCapMs}ms`);
  }
}
