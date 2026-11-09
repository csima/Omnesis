// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  RetrievalCriticTurn,
  buildCriticPrompt,
  describeRetrieval,
  parseVerdict,
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
    limits: { reviewsPerTurn: 4, revisionsPerTurn: 2, timeoutMs },
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
        ],
        rowCount: 4,
        truncated: true,
      },
    );
    expect(line).toContain("4 row(s), truncated");
    expect(line).toContain("columns workspace, n");
    expect(line).not.toContain('"D"');
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
  it("carries the request, the earlier retrieval and the latest", () => {
    const prompt = buildCriticPrompt(
      "Top discussion on Slack today",
      ["first call"],
      "second call",
    );
    expect(prompt).toContain("Top discussion on Slack today");
    expect(prompt).toContain("1. first call");
    expect(prompt).toContain("Latest retrieval:\nsecond call");
  });
});

describe("withRetrievalCritic", () => {
  it("leaves tools that do not retrieve alone", () => {
    const handle = tool("plan", slackHits);
    expect(critic(handle, reviewer(REVISE))).toBe(handle);
  });

  it("attaches the reviewer's note when the retrieval cannot answer the request", async () => {
    const model = reviewer(REVISE);
    const result = await critic(tool("search_documents", slackHits), model).invoke(
      { query: "x" },
      ctx,
    );
    expect(result).toMatchObject({
      kind: "search.results",
      review: { verdict: "revise", note: "Count messages per workspace with run_sql first." },
    });
    expect(model.prompts[0]).toContain("Top discussion on Slack today");
  });

  it("returns an adequate result unchanged", async () => {
    const result = await critic(
      tool("search_documents", slackHits),
      reviewer('{"verdict":"adequate"}'),
    ).invoke({}, ctx);
    expect(result).toBe(slackHits);
  });

  it("does nothing when the session has no turn under review", async () => {
    const model = reviewer(REVISE);
    const result = await critic(tool("search_documents", slackHits), model, null).invoke({}, ctx);
    expect(result).toBe(slackHits);
    expect(model.prompts).toHaveLength(0);
  });

  it("fails open with no reviewer, a failing reviewer or a slow one", async () => {
    const handle = tool("search_documents", slackHits);
    expect(await critic(handle, null).invoke({}, ctx)).toBe(slackHits);
    const failing = reviewer(() => Promise.reject(new Error("503")));
    expect(await critic(handle, failing).invoke({}, ctx)).toBe(slackHits);
    const slow = reviewer(() => new Promise((resolve) => setTimeout(() => resolve(REVISE), 200)));
    expect(await critic(handle, slow, new RetrievalCriticTurn("q"), 20).invoke({}, ctx)).toBe(
      slackHits,
    );
  });

  it("shows later reviews what was already retrieved this turn", async () => {
    const model = reviewer('{"verdict":"adequate"}');
    const turn = new RetrievalCriticTurn("Top discussion on Slack today");
    await critic(tool("search_documents", slackHits), model, turn).invoke({ query: "a" }, ctx);
    await critic(
      tool("run_sql", { kind: "error", code: "bad", message: "no" }),
      model,
      turn,
    ).invoke({}, ctx);
    await critic(tool("search_documents", slackHits), model, turn).invoke({ query: "b" }, ctx);
    expect(turn.retrievals).toHaveLength(3);
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain("2. run_sql");
  });

  it("stops revising once the turn's revisions are spent", async () => {
    const model = reviewer(REVISE);
    const turn = new RetrievalCriticTurn("q");
    const handle = critic(tool("search_documents", slackHits), model, turn);
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await handle.invoke({}, ctx));
    expect(results.filter((r) => "review" in r && r.review)).toHaveLength(2);
    expect(model.prompts).toHaveLength(2);
  });

  it("reviews one call at a time when a round runs several at once", async () => {
    let release: (value: string) => void = () => {};
    const model = reviewer(() => new Promise<string>((resolve) => (release = resolve)));
    const turn = new RetrievalCriticTurn("q");
    const handle = critic(tool("search_documents", slackHits), model, turn);
    const first = handle.invoke({ query: "a" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await handle.invoke({ query: "b" }, ctx);
    expect(second).toBe(slackHits);
    release(REVISE);
    expect(await first).toMatchObject({ review: { verdict: "revise" } });
    expect(model.prompts).toHaveLength(1);
    expect(turn.retrievals).toHaveLength(2);
  });
});
