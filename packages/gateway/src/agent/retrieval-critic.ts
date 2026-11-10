// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Retrieval critic — a judge between the chat agent's retrieval and its answer.
 *
 * The agent decides how to retrieve on its own, and sometimes retrieves in a
 * way that cannot answer what was asked: a handful of relevance-search hits
 * summarised as "the top discussions" across sixteen workspaces, a filter the
 * request never implied, the first page of a truncated result taken as the
 * whole. Rather than a prompt rule for each such case, a reviewer model judges
 * the turn's retrieval against the request at the moment the agent commits to
 * an answer: when it records the answer's sources. A rejection refuses the
 * citation with the reviewer's note — what is missing and the retrieval that
 * would supply it — so the agent cannot hand over a sourced answer built on
 * retrieval the reviewer rejected. Once it has retrieved more, its next
 * citation is judged again; a pass records it.
 *
 * Judging at the answer rather than after every call means intermediate steps
 * (a schema lookup, a sample of rows) are never judged as if they were the
 * answer, and a verdict never outlives the retrieval it judged.
 *
 * Wrapping the tools, rather than hooking a backend's loop, reaches every
 * backend, including the external runtimes whose loops Omnesis cannot enter.
 *
 * Bounded and fail-open: a turn gets a few reviews and at most two refused
 * citations, after which the agent may answer and must open by saying what it
 * did not cover; a review that errors or outlasts its timeout passes; and no
 * reviewer model means no review.
 */

import { createLogger, type CompleteCapability, type ToolResult } from "@omnesis/core";
import type { ToolContext, ToolHandle } from "@omnesis/agent";

const log = createLogger("gateway:agent").child("retrieval-critic");

/** The tools that record an answer's sources: where the retrieval is judged. */
export const CITATION_TOOLS: ReadonlySet<string> = new Set([
  "annotate",
  "annotate_many",
  "cite_record",
]);

/** The tools whose results answer "what is in the corpus": what the judge sees. */
export const REVIEWED_TOOLS: ReadonlySet<string> = new Set([
  "search_many",
  "search_documents",
  "fetch_many",
  "temporal_query",
  "run_sql",
  "count_messages",
  "lookup_people",
  "search_loops",
]);

export interface RetrievalCriticLimits {
  /** Reviews per turn. Past it, the last verdict stands. */
  readonly reviewsPerTurn: number;
  /** Citations refused per turn; past it the agent may answer. */
  readonly refusalsPerTurn: number;
  readonly timeoutMs: number;
}

export const DEFAULT_RETRIEVAL_CRITIC_LIMITS: RetrievalCriticLimits = {
  reviewsPerTurn: 4,
  refusalsPerTurn: 2,
  timeoutMs: 20_000,
};

export type RetrievalVerdict = { verdict: "adequate" } | { verdict: "revise"; note: string };

const PASS: RetrievalVerdict = { verdict: "adequate" };

/** What the critic knows of one turn: the request, the retrieval so far and its verdicts. */
export class RetrievalCriticTurn {
  readonly retrievals: string[] = [];
  reviews = 0;
  refusals = 0;
  /** The latest verdict, and how many retrievals it judged. */
  verdict: RetrievalVerdict = PASS;
  judged = 0;
  /** Calls in one model round run concurrently; they share one review. */
  judging: Promise<RetrievalVerdict> | null = null;

  constructor(readonly request: string) {}
}

const MAX_ARGS_CHARS = 600;
const MAX_ROW_CHARS = 240;
const MAX_DATA_CHARS = 700;
const MAX_NOTE_CHARS = 600;
const MAX_REQUEST_CHARS = 2_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}

type SearchResults = Extract<ToolResult, { kind: "search.results" }>;

function describeSearch(result: SearchResults): string {
  const bySource = new Map<string, number>();
  const accounts = new Set<string>();
  for (const doc of result.results) {
    bySource.set(doc.sourceType, (bySource.get(doc.sourceType) ?? 0) + 1);
    accounts.add(doc.sourceId);
  }
  const sources = [...bySource].map(([type, count]) => `${type} ${count}`).join(", ") || "none";
  const candidates = result.candidates === undefined ? "" : ` of ${result.candidates} candidates`;
  const coverage = result.coverage ? `; coverage ${result.coverage.status}` : "";
  return `query ${json(result.query)}: ${result.results.length} returned${candidates}; by source: ${sources}; from ${accounts.size} account(s)${coverage}`;
}

/** A compact, model-readable account of one retrieval call and what it returned. */
export function describeRetrieval(tool: string, args: unknown, result: ToolResult): string {
  const call = `${tool}(${clip(json(args), MAX_ARGS_CHARS)})`;
  switch (result.kind) {
    case "search.results":
      return `${call} → ${describeSearch(result)}`;
    case "search.batch":
      return `${call} → ${result.items
        .map((item) =>
          item.kind === "search.results" ? describeSearch(item) : `error ${item.code}`,
        )
        .join(" | ")}`;
    case "sql.rows": {
      const head = result.rows
        .slice(0, 5)
        .map((row) => clip(json(row), MAX_ROW_CHARS))
        .join("; ");
      return `${call} → ${result.rowCount} row(s)${result.truncated ? ", truncated" : ""}; columns ${result.columns.join(", ")}${head ? `; first rows: ${head}` : ""}`;
    }
    case "structured":
      return `${call} → ${result.resultType}: ${clip(json(result.data), MAX_DATA_CHARS)}`;
    case "document.batch": {
      const read = result.items.flatMap((item) => (item.kind === "document" ? [item] : []));
      const bySource = new Map<string, number>();
      for (const item of read) {
        bySource.set(item.ref.sourceType, (bySource.get(item.ref.sourceType) ?? 0) + 1);
      }
      const sources = [...bySource].map(([type, count]) => `${type} ${count}`).join(", ");
      const failed = result.items.length - read.length;
      return `${call} → ${read.length} document(s) read${sources ? ` (${sources})` : ""}${failed ? `, ${failed} not readable` : ""}`;
    }
    case "error":
      return `${call} → error ${result.code}: ${clip(result.message, MAX_ROW_CHARS)}`;
    default:
      return `${call} → ${result.kind}`;
  }
}

export function buildCriticPrompt(request: string, retrievals: readonly string[]): string {
  return `You judge an assistant's retrieval before it answers the user. The assistant answers from the user's own corpus — email, chat and messaging workspaces, files, calendar and more — with these tools: search_many and search_documents (relevance search: a few best-matching documents per query, not everything that matches), temporal_query (everything dated within a window), run_sql (exact counts and aggregates over the sources' tables), count_messages (message counts per person), fetch_many (reading documents).

The user's request:
<request>
${clip(request, MAX_REQUEST_CHARS)}
</request>

The assistant has finished retrieving and is about to answer. Its retrieval in this turn, oldest first:
${retrievals.map((line, i) => `${i + 1}. ${line}`).join("\n")}

Judge one thing: does this retrieval, taken together, support a complete and correct answer to the request as the user asked it? Later calls can make up for earlier ones: a sample followed by an exact count is a count. The usual ways it cannot:
- A ranking, total, comparison or "top / most / all / every" question answered from a handful of relevance-search hits. Hits are a sample, not a count: the question needs counts or a full enumeration over everything in scope.
- A scope narrower than the request: a source, account, workspace, person or time window the request does not imply, or one of several sources the request covers.
- A truncated, partial or still-catching-up result treated as the whole.
- Queries that do not match what was asked.

Narrow requests that the results answer are adequate; do not ask for more for its own sake.

Reply with one line of JSON and nothing else, either
{"verdict":"adequate"}
or
{"verdict":"revise","note":"<one or two sentences to the assistant: what is missing, and the tool call that would fix it>"}`;
}

/** Reads the reviewer's reply. Anything unclear is adequate: the critic fails open. */
export function parseVerdict(text: string): RetrievalVerdict {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { verdict: "adequate" };
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { verdict?: unknown; note?: unknown };
    if (parsed.verdict === "revise" && typeof parsed.note === "string" && parsed.note.trim()) {
      return { verdict: "revise", note: clip(parsed.note.trim(), MAX_NOTE_CHARS) };
    }
  } catch {
    // Unparseable: fall through to adequate.
  }
  return PASS;
}

async function review(
  completer: CompleteCapability,
  prompt: string,
  timeoutMs: number,
): Promise<RetrievalVerdict> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const text = await Promise.race([
      completer.complete(prompt, { maxTokens: 300, temperature: 0 }),
      timeout,
    ]);
    if (text === null) {
      log.warn(`review timed out after ${timeoutMs}ms; passing`);
      return PASS;
    }
    return parseVerdict(text);
  } catch (err) {
    log.warn(`review failed; passing: ${err instanceof Error ? err.message : String(err)}`);
    return PASS;
  } finally {
    clearTimeout(timer);
  }
}

export interface RetrievalCriticDeps {
  /** The turn a call belongs to, or undefined when the session is not under review. */
  readonly turn: (ctx: ToolContext) => RetrievalCriticTurn | undefined;
  /** The reviewer model, or null when none is available. */
  readonly completer: () => CompleteCapability | null;
  readonly limits?: RetrievalCriticLimits;
}

/**
 * What a citation gets back while the reviewer's rejection stands. The last
 * refusal says what happens next, so the answer that follows it can say what
 * it does not cover.
 */
export function refusedCitation(note: string, last = false): ToolResult {
  const next = last
    ? "If that retrieval is not possible, your next citation will be recorded, and your answer must open by saying plainly what it does not cover and why."
    : "Your next citation is judged again against everything you have retrieved by then.";
  return {
    kind: "error",
    code: "retrieval_review_pending",
    message: `Not recorded. A review of your retrieval found that it cannot answer the request yet: ${note} Carry out that retrieval now. ${next} The user has seen nothing of this: your answer is still your first, so do not describe it as a correction.`,
  };
}

/** The verdict on the turn's retrieval so far: reviewed again only when there is retrieval it has not seen. */
function judge(
  turn: RetrievalCriticTurn,
  ctx: ToolContext,
  deps: RetrievalCriticDeps,
  limits: RetrievalCriticLimits,
): Promise<RetrievalVerdict> {
  if (turn.judging) return turn.judging;
  const seen = turn.retrievals.length;
  if (seen === 0 || seen === turn.judged || turn.reviews >= limits.reviewsPerTurn) {
    return Promise.resolve(turn.verdict);
  }
  let completer: CompleteCapability | null;
  try {
    completer = deps.completer();
  } catch (err) {
    log.warn(`reviewer unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return Promise.resolve(PASS);
  }
  if (!completer) return Promise.resolve(PASS);
  turn.reviews += 1;
  const n = turn.reviews;
  turn.judging = review(
    completer,
    buildCriticPrompt(turn.request, turn.retrievals.slice(0, seen)),
    limits.timeoutMs,
  )
    .then((verdict) => {
      turn.verdict = verdict;
      turn.judged = seen;
      log.info(
        `session ${ctx.sessionId}: review ${n}/${limits.reviewsPerTurn} of ${seen} retrieval(s) ${verdict.verdict === "adequate" ? "passed" : "revise"}`,
      );
      return verdict;
    })
    .finally(() => {
      turn.judging = null;
    });
  return turn.judging;
}

/**
 * Records the answer's sources only once the turn's retrieval passes review.
 * Past the turn's refusals the citation is recorded either way, but retrieval
 * made since the last verdict is still judged, so the log and the turn's
 * verdict say whether it passed.
 */
function withCitationGate(handle: ToolHandle, deps: RetrievalCriticDeps): ToolHandle {
  const limits = deps.limits ?? DEFAULT_RETRIEVAL_CRITIC_LIMITS;
  return {
    ...handle,
    invoke: async (args, ctx) => {
      const turn = deps.turn(ctx);
      if (!turn) return handle.invoke(args, ctx);
      const verdict = await judge(turn, ctx, deps, limits);
      if (verdict.verdict === "adequate" || ctx.abortSignal?.aborted) {
        return handle.invoke(args, ctx);
      }
      if (turn.refusals >= limits.refusalsPerTurn) {
        log.info(`session ${ctx.sessionId} ${handle.name}: recorded past the refusal limit`);
        return handle.invoke(args, ctx);
      }
      turn.refusals += 1;
      log.info(
        `session ${ctx.sessionId} ${handle.name}: refused (${turn.refusals}/${limits.refusalsPerTurn})`,
      );
      return refusedCitation(verdict.note, turn.refusals >= limits.refusalsPerTurn);
    },
  };
}

/** Keeps a retrieval tool's calls for the judge; the result itself is unchanged. */
function withRetrievalRecord(handle: ToolHandle, deps: RetrievalCriticDeps): ToolHandle {
  return {
    ...handle,
    invoke: async (args, ctx) => {
      const result = await handle.invoke(args, ctx);
      deps.turn(ctx)?.retrievals.push(describeRetrieval(handle.name, args, result));
      return result;
    },
  };
}

/**
 * Wraps a tool into the review: a retrieval tool's calls are kept for the
 * judge, a citation is recorded only once the retrieval passes, and any other
 * tool comes back as it was.
 */
export function withRetrievalCritic(handle: ToolHandle, deps: RetrievalCriticDeps): ToolHandle {
  if (CITATION_TOOLS.has(handle.name)) return withCitationGate(handle, deps);
  if (REVIEWED_TOOLS.has(handle.name)) return withRetrievalRecord(handle, deps);
  return handle;
}
