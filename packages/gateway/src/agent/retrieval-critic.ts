// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Retrieval critic — a second look at the chat agent's retrieval, mid-turn.
 *
 * The agent decides how to retrieve on its own, and sometimes retrieves in a
 * way that cannot answer what was asked: a handful of relevance-search hits
 * summarised as "the top discussions" across sixteen workspaces, a filter the
 * request never implied, the first page of a truncated result taken as the
 * whole. Rather than a prompt rule for each such case, every retrieval result
 * is judged by a reviewer model against the request. When the reviewer judges
 * that the results cannot support a complete answer, its note rides on the
 * result the agent reads next — `review` on the tool result — and the verdict
 * binds: until a later retrieval passes review, the agent's citations are
 * refused, so it cannot hand over a sourced answer built on retrieval the
 * reviewer rejected. It has to fix the retrieval first.
 *
 * Wrapping the tools, rather than hooking a backend's loop, reaches every
 * backend, including the external runtimes whose loops Omnesis cannot enter.
 *
 * Every review's verdict stands until the next one: a rejection holds the
 * citations with its note, and a pass releases them.
 *
 * Bounded and fail-open: a turn gets a few reviews and at most two refused
 * citations, after which the agent may answer and must open by saying what it
 * did not cover; a review that errors or outlasts its timeout passes the
 * result through untouched; and no reviewer model means no review.
 */

import { createLogger, type CompleteCapability, type ToolResult } from "@omnesis/core";
import type { ToolContext, ToolHandle } from "@omnesis/agent";

const log = createLogger("gateway:agent").child("retrieval-critic");

/** The tools that record an answer's sources: held while a rejection stands. */
export const CITATION_TOOLS: ReadonlySet<string> = new Set([
  "annotate",
  "annotate_many",
  "cite_record",
]);

/** The tools whose results answer "what is in the corpus". */
export const REVIEWED_TOOLS: ReadonlySet<string> = new Set([
  "search_many",
  "search_documents",
  "temporal_query",
  "run_sql",
  "count_messages",
  "lookup_people",
  "search_loops",
]);

export interface RetrievalCriticLimits {
  /** Reviews per turn. Retrieval past it is not reviewed, and the last verdict stands. */
  readonly reviewsPerTurn: number;
  /** Citations refused per turn while a rejection stands; past it the agent may answer. */
  readonly refusalsPerTurn: number;
  readonly timeoutMs: number;
}

export const DEFAULT_RETRIEVAL_CRITIC_LIMITS: RetrievalCriticLimits = {
  reviewsPerTurn: 6,
  refusalsPerTurn: 2,
  timeoutMs: 20_000,
};

/** What the critic knows of one turn: the request, and the retrieval so far. */
export class RetrievalCriticTurn {
  readonly retrievals: string[] = [];
  reviews = 0;
  refusals = 0;
  /** Calls in one model round run concurrently; one review at a time. */
  reviewing = false;
  /**
   * The reviewer's standing rejection: the note of the latest review when it
   * found the retrieval insufficient; null once a review passes.
   */
  pending: string | null = null;

  constructor(readonly request: string) {}
}

export type RetrievalVerdict = { verdict: "adequate" } | { verdict: "revise"; note: string };

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
        .slice(0, 3)
        .map((row) => clip(json(row), MAX_ROW_CHARS))
        .join("; ");
      return `${call} → ${result.rowCount} row(s)${result.truncated ? ", truncated" : ""}; columns ${result.columns.join(", ")}${head ? `; first rows: ${head}` : ""}`;
    }
    case "structured":
      return `${call} → ${result.resultType}: ${clip(json(result.data), MAX_DATA_CHARS)}`;
    case "error":
      return `${call} → error ${result.code}: ${clip(result.message, MAX_ROW_CHARS)}`;
    default:
      return `${call} → ${result.kind}`;
  }
}

export function buildCriticPrompt(
  request: string,
  earlier: readonly string[],
  latest: string,
): string {
  const history = earlier.length
    ? `Earlier retrieval in this turn, oldest first:\n${earlier.map((line, i) => `${i + 1}. ${line}`).join("\n")}\n\n`
    : "";
  return `You review an assistant's retrieval before it answers the user. The assistant answers from the user's own corpus — email, chat and messaging workspaces, files, calendar and more — with these tools: search_many and search_documents (relevance search: a few best-matching documents per query, not everything that matches), temporal_query (everything dated within a window), run_sql (exact counts and aggregates over the sources' tables), count_messages (message counts per person), fetch_many (reading documents).

The user's request:
<request>
${clip(request, MAX_REQUEST_CHARS)}
</request>

${history}Latest retrieval:
${latest}

Judge one thing: can the retrieval so far support a complete and correct answer to the request as the user asked it? The usual ways it cannot:
- A ranking, total, comparison or "top / most / all / every" question answered from a handful of relevance-search hits. Hits are a sample, not a count: the question needs counts or a full enumeration over everything in scope first.
- A scope narrower than the request: a source, account, workspace, person or time window the request does not imply, or one of several sources the request covers.
- A truncated, partial or still-catching-up result treated as the whole.
- Queries that do not match what was asked.

Narrow requests that the results already answer are adequate; do not ask for more for its own sake. Retrieval the assistant has plainly not finished yet is adequate too — judge only gaps that the results so far would carry into the answer.

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
  return { verdict: "adequate" };
}

/** Attaches the note to a result that can carry one; any other result passes through unchanged. */
export function withReview(result: ToolResult, note: string): ToolResult {
  switch (result.kind) {
    case "search.results":
    case "search.batch":
    case "sql.rows":
    case "structured":
      return { ...result, review: { verdict: "revise", note } };
    default:
      return result;
  }
}

function canCarryReview(result: ToolResult): boolean {
  return withReview(result, "x") !== result;
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
      log.warn(`review timed out after ${timeoutMs}ms; passing the result through`);
      return { verdict: "adequate" };
    }
    return parseVerdict(text);
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
    : "Citations are accepted once a retrieval passes review.";
  return {
    kind: "error",
    code: "retrieval_review_pending",
    message: `Not recorded. The retrieval review found that what you have retrieved cannot answer the request yet: ${note} Carry out that retrieval now. ${next}`,
  };
}

/** Holds a citation while the reviewer's rejection stands, up to the turn's refusals. */
function withCitationGate(handle: ToolHandle, deps: RetrievalCriticDeps): ToolHandle {
  const limits = deps.limits ?? DEFAULT_RETRIEVAL_CRITIC_LIMITS;
  return {
    ...handle,
    invoke: async (args, ctx) => {
      const turn = deps.turn(ctx);
      if (turn?.pending && turn.refusals < limits.refusalsPerTurn) {
        turn.refusals += 1;
        log.info(
          `session ${ctx.sessionId} ${handle.name}: held for the retrieval review (${turn.refusals}/${limits.refusalsPerTurn})`,
        );
        return refusedCitation(turn.pending, turn.refusals >= limits.refusalsPerTurn);
      }
      return handle.invoke(args, ctx);
    },
  };
}

/**
 * Wraps a tool into the review: a retrieval tool's results are judged, a
 * citation tool is held while a rejection stands, and any other tool comes
 * back as it was.
 */
export function withRetrievalCritic(handle: ToolHandle, deps: RetrievalCriticDeps): ToolHandle {
  if (CITATION_TOOLS.has(handle.name)) return withCitationGate(handle, deps);
  if (!REVIEWED_TOOLS.has(handle.name)) return handle;
  const limits = deps.limits ?? DEFAULT_RETRIEVAL_CRITIC_LIMITS;
  return {
    ...handle,
    invoke: async (args, ctx) => {
      const result = await handle.invoke(args, ctx);
      const turn = deps.turn(ctx);
      if (!turn || ctx.abortSignal?.aborted) return result;
      const latest = describeRetrieval(handle.name, args, result);
      const earlier = [...turn.retrievals];
      turn.retrievals.push(latest);
      if (!canCarryReview(result) || turn.reviewing || turn.reviews >= limits.reviewsPerTurn) {
        return result;
      }
      let completer: CompleteCapability | null;
      try {
        completer = deps.completer();
      } catch (err) {
        log.warn(`reviewer unavailable: ${err instanceof Error ? err.message : String(err)}`);
        return result;
      }
      if (!completer) return result;
      turn.reviewing = true;
      turn.reviews += 1;
      try {
        const verdict = await review(
          completer,
          buildCriticPrompt(turn.request, earlier, latest),
          limits.timeoutMs,
        );
        const progress = `session ${ctx.sessionId} ${handle.name}: review ${turn.reviews}/${limits.reviewsPerTurn}`;
        if (verdict.verdict === "adequate") {
          log.info(`${progress} passed${turn.pending ? ", citations released" : ""}`);
          turn.pending = null;
          return result;
        }
        turn.pending = verdict.note;
        log.info(`${progress} revise`);
        return withReview(result, verdict.note);
      } catch (err) {
        log.warn(
          `review failed; passing the result through: ${err instanceof Error ? err.message : String(err)}`,
        );
        return result;
      } finally {
        turn.reviewing = false;
      }
    },
  };
}
