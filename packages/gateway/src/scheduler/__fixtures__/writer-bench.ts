// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the writer hold suites share: where their database lives, and how much
 * of a wait was the writer's own WAL checkpoints.
 *
 * These suites hold an op to what its own work costs the writer: the rows it
 * touches in one call, the frames one checkpoint copies, whether a write
 * queued behind it gets in. The disk's latency is not that work. Every
 * checkpoint flushes the WAL and the database file, and under sustained writes
 * the kernel can hold a commit's own writes back while it writes dirty pages
 * out. On a shared CI runner that stretched a 2 MiB checkpoint to 380 ms and a
 * 40-document upsert to 572 ms, past budgets every other call in the same run
 * kept with room to spare. A memory-backed directory takes the disk out and
 * leaves the work, so a regression that copies or scans too much still shows;
 * the system temp directory is the fallback where there is none.
 */

import { existsSync, accessSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scheduler } from "../scheduler.js";

const MEMORY_DIR = "/dev/shm";

function memoryBacked(): boolean {
  if (!existsSync(MEMORY_DIR)) return false;
  try {
    accessSync(MEMORY_DIR, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** A fresh database path for a writer hold suite, memory-backed where the host has one. */
export function writerBenchDbPath(prefix = "omnesis-test"): string {
  return join(memoryBacked() ? MEMORY_DIR : tmpdir(), `${prefix}-${randomUUID()}.db`);
}

/**
 * Milliseconds the writer has spent in WAL checkpoints since it started.
 *
 * The writer checkpoints between ops once enough frames wait, so a write that
 * lands right after a large op runs only after the copy that op's frames
 * started. Take the difference across a wait to leave out that copy: its cost
 * is the WAL checkpoint suite's to bound, not the op's.
 */
export function checkpointedMs(scheduler: Scheduler): number {
  return scheduler.snapshot(3_600).walCheckpoints?.lifetime.totalMs ?? 0;
}
