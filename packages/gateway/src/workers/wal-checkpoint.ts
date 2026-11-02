// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The writer's WAL checkpoints, run on the writer's own connection between
 * ops — never on a second writable handle (see `writer-worker.ts`).
 *
 * A checkpoint copies every page written since the last one back into
 * `omnesis.db`, so its cost grows with the frames waiting. One a minute left a
 * minute of writes per checkpoint: seconds of writer hold on a large encrypted
 * install. Checkpointing whenever `pendingFrames` frames wait keeps each copy
 * small, and an idle tick picks up the rest.
 *
 * A checkpoint does not shrink the WAL: the next writer only rewinds it once
 * every frame is copied and no reader still reads from it
 * (https://sqlite.org/wal.html#ckpt). With readers always running, that
 * instant never comes and the WAL grows without bound. Once it passes
 * `restartFrames` the writer makes the instant: it finishes the copy, then
 * runs a RESTART that waits at most `restartWaitMs` for the reads in flight.
 * A reader that starts after the copy is complete reads the database file,
 * not the WAL, so only reads already running can hold the rewind off; a
 * longer one makes the attempt give up, and the next waits a backoff that
 * doubles while readers keep it off, so a scan of a minute costs the writer a
 * few percent of its time, and a rewind follows soon after the scan ends. `journal_size_limit` (set on the connection) then truncates the
 * rewound file.
 *
 * Every mode used here copies frames and rewrites the wal-index header in
 * place. None truncates or resizes `-shm`, and none is TRUNCATE.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;

export interface WalCheckpointPolicy {
  /** Uncopied frames that start a checkpoint between ops. */
  pendingFrames: number;
  /** WAL length, in frames, past which the writer rewinds it. */
  restartFrames: number;
  /** Longest one rewind attempt waits for readers, ms. */
  restartWaitMs: number;
  /**
   * The wait before retrying a rewind readers held off, ms: doubled on each
   * further deferral up to `restartRetryMaxMs`, reset by a rewind.
   */
  restartRetryMinMs: number;
  restartRetryMaxMs: number;
  /** The connection's `busy_timeout` outside a rewind, ms. */
  busyTimeoutMs: number;
}

/**
 * About 8 MiB of 4 KiB pages per checkpoint, tens of milliseconds encrypted;
 * a rewind once the WAL holds about 64 MiB, the size `journal_size_limit`
 * truncates it back to.
 */
export const DEFAULT_WAL_CHECKPOINT_POLICY: WalCheckpointPolicy = {
  pendingFrames: 2_000,
  restartFrames: 16_384,
  restartWaitMs: 100,
  restartRetryMinMs: 250,
  restartRetryMaxMs: 5_000,
  busyTimeoutMs: 5_000,
};

/** Bytes the WAL file is truncated to after a rewind. */
export const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

export interface WalCheckpointRun {
  mode: "PASSIVE" | "RESTART";
  /** RESTART only: whether the WAL was rewound. */
  restarted: boolean;
  /** Frames in the WAL when the run ended. */
  log: number;
  /** Frames copied into the database when the run ended. */
  checkpointed: number;
  ms: number;
}

interface CheckpointRow {
  busy: number;
  log: number;
  checkpointed: number;
}

const RESTART_POLL_MS = 2;

export class WalCheckpointer {
  private readonly probe: Database.Statement<[], CheckpointRow>;
  private readonly passive: Database.Statement<[], CheckpointRow>;
  private readonly restart: Database.Statement<[], CheckpointRow>;
  private readonly sleepCell = new Int32Array(new SharedArrayBuffer(4));
  private nextRestartMs = Number.NEGATIVE_INFINITY;
  private retryMs = 0;

  constructor(
    private readonly db: Db,
    private readonly policy: WalCheckpointPolicy = DEFAULT_WAL_CHECKPOINT_POLICY,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.probe = db.prepare("PRAGMA wal_checkpoint(NOOP)");
    this.passive = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
    this.restart = db.prepare("PRAGMA wal_checkpoint(RESTART)");
  }

  /**
   * Between ops: copy once `minPending` frames wait (the policy's
   * `pendingFrames` by default), rewind once the WAL is long. Returns what
   * ran, or null when nothing did. A database not in WAL mode reports no
   * frames, so nothing runs.
   */
  maintain(minPending = this.policy.pendingFrames): WalCheckpointRun | null {
    const state = this.probe.get()!;
    if (state.log <= 0) return null;
    const startedMs = this.now();
    if (state.log >= this.policy.restartFrames && startedMs >= this.nextRestartMs) {
      const run = this.rewind(startedMs);
      this.retryMs = run.restarted
        ? 0
        : Math.min(
            this.policy.restartRetryMaxMs,
            Math.max(this.policy.restartRetryMinMs, this.retryMs * 2),
          );
      this.nextRestartMs = this.now() + this.retryMs;
      return run;
    }
    if (state.log - state.checkpointed < Math.max(1, minPending)) return null;
    const row = this.passive.get()!;
    return this.result("PASSIVE", false, row, startedMs);
  }

  /**
   * Copy every frame, then wait for the reads still on the WAL. Readers
   * holding a snapshot older than the last commit pin frames a copy may not
   * overwrite; each returns to the latest snapshot at its next statement, so
   * the copy is retried until it is complete or the wait is spent.
   */
  private rewind(startedMs: number): WalCheckpointRun {
    const deadline = startedMs + this.policy.restartWaitMs;
    let row = this.passive.get()!;
    while (row.checkpointed < row.log && this.now() < deadline) {
      Atomics.wait(this.sleepCell, 0, 0, RESTART_POLL_MS);
      row = this.passive.get()!;
    }
    const remainingMs = Math.floor(deadline - this.now());
    if (row.checkpointed < row.log || remainingMs <= 0) {
      return this.result("RESTART", false, row, startedMs);
    }
    this.db.pragma(`busy_timeout = ${remainingMs}`);
    try {
      row = this.restart.get()!;
    } finally {
      this.db.pragma(`busy_timeout = ${this.policy.busyTimeoutMs}`);
    }
    return this.result("RESTART", row.busy === 0, row, startedMs);
  }

  private result(
    mode: WalCheckpointRun["mode"],
    restarted: boolean,
    row: CheckpointRow,
    startedMs: number,
  ): WalCheckpointRun {
    return {
      mode,
      restarted,
      log: row.log,
      checkpointed: row.checkpointed,
      ms: this.now() - startedMs,
    };
  }
}
