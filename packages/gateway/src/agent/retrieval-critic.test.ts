// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  RetrievalCriticTurn,
  buildCriticPrompt,
  describeRetrieval,
  parseVerdict,
  refusedCitation,
  withRetrievalCritic,
} from "./retrieval-critic.js";
import type { ToolContext, ToolHandle } from "@omnesis/agent";
import type { CompleteCapability, ToolResult } from "@omnesis/core";

const ctx: ToolContext = { sessionId: "s1", messageId: "m1" };

function searchResult(query: string, docs: ReadonlyArray<[string, string]>): ToolResult {
  return {
    kind: "search.results",
    query,
    durationMs: 5,
    candidates: 120,
    coverage: { status: "scanned", corpusBoundary: null, publishedThrough: null, notice: "" },
    results: docs.map(([sourceType, sourceId], i) => ({
      documentId: `d${i}`,
      sourceType,
      sourceId,
    })),
  };
}

const slackHits = searchResult("slack discussion", [
  ["slack", "slack:T1"],
  ["slack", "slack:T1"],
  ["slack", "slack:T2"],
]);

function tool(name: string, result: ToolResult): ToolHandle {
  return {
    name,
    description: name,
    schema: z.unknown(),
    invoke: async () => result,
  };
}

function reviewer(
  reply: string | (() => Promise<string>),
): CompleteCapability & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: "fake",
    modelId: "fake-model",
    prompts,
    complete: async (prompt: string) => {
      prompts.push(prompt);
      return typeof reply === "string" ? reply : reply();
    },
    dispose: async () => {},
  };
}

const REVISE = '{"verdict":"revise","note":"Count messages per workspace with run_sql first."}';

function critic(
  handle: ToolHandle,
  completer: CompleteCapability | null,
  turn: RetrievalCriticTurn | null = new RetrievalCriticTurn("Top discussion on Slack today"),
  timeoutMs = 1_000,
) {
  return withRetrievalCritic(handle, {
    turn: () => turn ?? undefined,
    completer: () => completer,
    limits: { reviewsPerTurn: 4, refusalsPerTurn: 2, timeoutMs },
  });
}

describe("describeRetrieval", () => {
  it("counts a search's hits by source and account", () => {
    const line = describeRetrieval("search_documents", { query: "x" }, slackHits);
    expect(line).toContain("3 returned of 120 candidates");
    expect(line).toContain("by source: slack 3");
    expect(line).toContain("from 2 account(s)");
    expect(line).toContain("coverage scanned");
  });

  it("describes each query of a batch, errors included", () => {
    const line = describeRetrieval(
      "search_many",
      {},
      {
        kind: "search.batch",
        items: [slackHits, { kind: "error", code: "timeout", message: "slow" }],
      },
    );
    expect(line).toContain('query "slack discussion"');
    expect(line).toContain("error timeout");
  });

  it("reports a SQL result's size and truncation without every row", () => {
    const line = describeRetrieval(
      "run_sql",
      { sql: "select 1" },
      {
        kind: "sql.rows",
        sql: "select 1",
        columns: ["workspace", "n"],
        rows: [
          ["A", 40],
          ["B", 30],
          ["C", 20],
          ["D", 10],
          ["E", 5],
          ["F", 2],
        ],
        rowCount: 6,
        truncated: true,
      },
    );
    expect(line).toContain("6 row(s), truncated");
    expect(line).toContain("columns workspace, n");
    expect(line).toContain('"E"');
    expect(line).not.toContain('"F"');
  });
});

describe("parseVerdict", () => {
  it("reads a revision with its note", () => {
    expect(parseVerdict(REVISE)).toEqual({
      verdict: "revise",
      note: "Count messages per workspace with run_sql first.",
    });
  });

  it("reads JSON wrapped in prose or a code fence", () => {
    expect(parseVerdict("Here you go:\n```json\n" + REVISE + "\n```").verdict).toBe("revise");
  });

  it("treats anything unclear as adequate", () => {
    expect(parseVerdict('{"verdict":"adequate"}')).toEqual({ verdict: "adequate" });
    expect(parseVerdict("not json")).toEqual({ verdict: "adequate" });
    expect(parseVerdict('{"verdict":"revise","note":"  "}')).toEqual({ verdict: "adequate" });
    expect(parseVerdict('{"verdict":"revise"')).toEqual({ verdict: "adequate" });
  });
});

describe("buildCriticPrompt", () => {
  it("carries the request and the whole retrieval, oldest first", () => {
    const prompt = buildCriticPrompt("Top discussion on Slack today", [
      "first call",
      "second call",
    ]);
    expect(prompt).toContain("Top discussion on Slack today");
    expect(prompt).toContain("1. first call\n2. second call");
  });

  it("reminds the judge of its own rejections, which only the asked-for retrieval answers", () => {
    const prompt = buildCriticPrompt(
      "q",
      ["a", "b", "c"],
      [{ judged: 1, note: "Count with run_sql." }],
    );
    expect(prompt).toContain("- after retrieval 1: Count with run_sql.");
    expect(prompt).toContain("A retrieval that returned nothing");
    expect(buildCriticPrompt("q", ["a"])).not.toContain("You rejected");
  });
});

const ADEQUATE = '{"verdict":"adequate"}';
const cited: ToolResult = { kind: "annotate.batch", items: [] };
const counted: ToolResult = {
  kind: "sql.rows",
  sql: "select workspace, count(*) from messages group by workspace",
  columns: ["workspace", "n"],
  rows: [["A", 40]],
  rowCount: 1,
};

/** One turn's tools, all reviewed by the same model. */
function tools(completer: CompleteCapability | null, turn: RetrievalCriticTurn | null) {
  const wrap = (handle: ToolHandle) => critic(handle, completer, turn);
  return {
    search: wrap(tool("search_many", slackHits)),
    sql: wrap(tool("run_sql", counted)),
    cite: wrap(tool("annotate_many", cited)),
  };
}

describe("withRetrievalCritic", () => {
  it("leaves tools that neither retrieve nor cite alone", () => {
    const handle = tool("plan", slackHits);
    expect(critic(handle, reviewer(REVISE))).toBe(handle);
  });

  it("keeps every retrieval for the judge and returns its result unchanged, unreviewed", async () => {
    const model = reviewer(REVISE);
    const turn = new RetrievalCriticTurn("q");
    const { search, sql } = tools(model, turn);
    expect(await search.invoke({ queries: [{ query: "a" }] }, ctx)).toBe(slackHits);
    expect(await sql.invoke({}, ctx)).toBe(counted);
    expect(turn.retrievals).toHaveLength(2);
    expect(model.prompts).toHaveLength(0);
  });

  it("judges the whole retrieval when the answer cites, and refuses with the note", async () => {
    const model = reviewer(REVISE);
    const turn = new RetrievalCriticTurn("Top discussion on Slack today");
    const { search, cite } = tools(model, turn);
    await search.invoke({ queries: [{ query: "discussion" }] }, ctx);
    const refused = await cite.invoke({}, ctx);
    expect(refused).toMatchObject({ kind: "error", code: "retrieval_review_pending" });
    expect((refused as { message: string }).message).toContain("Count messages per workspace");
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain("Top discussion on Slack today");
    expect(model.prompts[0]).toContain('1. search_many({"queries":[{"query":"discussion"}]})');
  });

  it("records the citation once a later retrieval passes, judging everything retrieved", async () => {
    const verdicts = [REVISE, ADEQUATE];
    const model = reviewer(async () => verdicts.shift()!);
    const turn = new RetrievalCriticTurn("q");
    const { search, sql, cite } = tools(model, turn);
    await search.invoke({}, ctx);
    expect(await cite.invoke({}, ctx)).toMatchObject({ code: "retrieval_review_pending" });
    await sql.invoke({}, ctx);
    expect(await cite.invoke({}, ctx)).toBe(cited);
    expect(model.prompts[1]).toContain("1. search_many");
    expect(model.prompts[1]).toContain("2. run_sql");
    expect(model.prompts[1]).toContain("after retrieval 1: Count messages per workspace");
  });

  it("does not review again without new retrieval", async () => {
    const model = reviewer(ADEQUATE);
    const turn = new RetrievalCriticTurn("q");
    const { search, cite } = tools(model, turn);
    await search.invoke({}, ctx);
    expect(await cite.invoke({}, ctx)).toBe(cited);
    expect(await cite.invoke({}, ctx)).toBe(cited);
    expect(model.prompts).toHaveLength(1);
  });

  it("lets the answer through after the turn's refusals, saying it must open with the gaps", async () => {
    const model = reviewer(REVISE);
    const turn = new RetrievalCriticTurn("q");
    const { search, cite } = tools(model, turn);
    await search.invoke({}, ctx);
    const first = (await cite.invoke({}, ctx)) as { code: string; message: string };
    expect(first.code).toBe("retrieval_review_pending");
    expect(first.message).not.toContain("does not cover");
    await search.invoke({}, ctx);
    const last = (await cite.invoke({}, ctx)) as { code: string; message: string };
    expect(last.code).toBe("retrieval_review_pending");
    expect(last.message).toContain("must open by saying plainly what it does not cover");
    await search.invoke({}, ctx);
    expect(await cite.invoke({}, ctx)).toBe(cited);
    // The retrieval since the last refusal was still judged.
    expect(model.prompts).toHaveLength(3);
  });

  it("past the refusals, a retrieval that now passes is recorded as passing", async () => {
    const verdicts = [REVISE, REVISE, ADEQUATE];
    const model = reviewer(async () => verdicts.shift()!);
    const turn = new RetrievalCriticTurn("q");
    const { search, sql, cite } = tools(model, turn);
    await search.invoke({}, ctx);
    await cite.invoke({}, ctx);
    await search.invoke({}, ctx);
    await cite.invoke({}, ctx);
    await sql.invoke({}, ctx);
    expect(await cite.invoke({}, ctx)).toBe(cited);
    expect(turn.verdict).toEqual({ verdict: "adequate" });
  });

  it("tells the agent the user has seen nothing yet", async () => {
    const refused = refusedCitation("Count first.") as { message: string };
    expect(refused.message).toContain("do not describe it as a correction");
  });

  it("shows the judge which documents were read", () => {
    const line = describeRetrieval("fetch_many", { ids: ["d0", "d1"] }, {
      kind: "document.batch",
      items: [
        {
          kind: "document",
          ref: { documentId: "d0", sourceType: "slack", sourceId: "slack:T1" },
          document: { title: "Release thread", content: "…" },
        },
        { kind: "error", code: "document_not_found", message: "gone" },
      ],
    } as ToolResult);
    expect(line).toContain("1 document(s) read (slack 1), 1 not readable");
  });

  it("keeps the last verdict once the turn's reviews are spent", async () => {
    const model = reviewer(REVISE);
    const turn = new RetrievalCriticTurn("q");
    const many = critic(tool("annotate", cited), model, turn);
    const search = critic(tool("search_many", slackHits), model, turn);
    turn.reviews = 4;
    turn.verdict = { verdict: "revise", note: "stale" };
    await search.invoke({}, ctx);
    const refused = (await many.invoke({}, ctx)) as { message: string };
    expect(refused.message).toContain("stale");
    expect(model.prompts).toHaveLength(0);
  });

  it("shares one review between citations made in the same round", async () => {
    let release: (value: string) => void = () => {};
    const model = reviewer(() => new Promise<string>((resolve) => (release = resolve)));
    const turn = new RetrievalCriticTurn("q");
    const { search, cite } = tools(model, turn);
    await search.invoke({}, ctx);
    const first = cite.invoke({}, ctx);
    const second = cite.invoke({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release(ADEQUATE);
    expect(await first).toBe(cited);
    expect(await second).toBe(cited);
    expect(model.prompts).toHaveLength(1);
  });

  it("records a citation with no retrieval to judge, no turn, or no working reviewer", async () => {
    const turn = new RetrievalCriticTurn("q");
    expect(await tools(reviewer(REVISE), turn).cite.invoke({}, ctx)).toBe(cited);
    expect(await tools(reviewer(REVISE), null).cite.invoke({}, ctx)).toBe(cited);
    const failing = reviewer(() => Promise.reject(new Error("503")));
    const t1 = new RetrievalCriticTurn("q");
    await tools(failing, t1).search.invoke({}, ctx);
    expect(await tools(failing, t1).cite.invoke({}, ctx)).toBe(cited);
    const slow = reviewer(() => new Promise((resolve) => setTimeout(() => resolve(REVISE), 200)));
    const t2 = new RetrievalCriticTurn("q");
    await critic(tool("search_many", slackHits), slow, t2, 20).invoke({}, ctx);
    expect(await critic(tool("annotate_many", cited), slow, t2, 20).invoke({}, ctx)).toBe(cited);
    const t3 = new RetrievalCriticTurn("q");
    await tools(null, t3).search.invoke({}, ctx);
    expect(await tools(null, t3).cite.invoke({}, ctx)).toBe(cited);
  });
});
