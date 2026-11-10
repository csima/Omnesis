// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The retrieval critic end to end: a conversation turn's retrieval is judged
 * by a reviewer before the agent answers, and a reviewer that judges it
 * insufficient reaches the agent as a note on the tool result it reads next,
 * in the same turn. The verdict binds: the agent's citations are refused until
 * a later retrieval passes review, and accepted once one has.
 *
 * The case is the one the critic was built for: "the top discussions" over
 * every workspace, answered from a few relevance-search hits.
 *
 * Both models are substituted at the production `agent`-role seam with one
 * scripted OpenAI-compatible server — the critic asks the conversation
 * agent's own model — which tells the two kinds of request apart by the
 * reviewer's prompt. No inference happens.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { SyntheticE2EHarness } from "./synth-harness.js";
import {
  startOpenAiServer,
  type OpenAiServerHandle,
  type WireMessage,
} from "./brain-bench/openai-server.js";

const MODEL_ID = "retrieval-critic-scripted-v1";
const TURN_TIMEOUT_MS = 90_000;
const QUESTION = "What were the top discussions across all my workspaces today?";
const REVIEWER_PROMPT = "You review an assistant's retrieval";
const NOTE =
  "Five relevance hits are a sample, not a count: count today's messages per workspace first.";
const CITE = {
  kind: "tool" as const,
  name: "annotate_many",
  args: { annotations: [{ documentId: "doc_1" }] },
};

interface ConversationRecordLike {
  messages?: Array<{ role: string; parts?: Array<Record<string, unknown>> }>;
}

describe("the retrieval critic", () => {
  let harness: SyntheticE2EHarness;
  let model: OpenAiServerHandle;
  const reviewerPrompts: string[] = [];
  const agentRequests: WireMessage[][] = [];

  beforeAll(async () => {
    model = await startOpenAiServer({
      modelId: MODEL_ID,
      respond: (messages) => {
        const reviewing = messages.some(
          (m) => typeof m.content === "string" && m.content.includes(REVIEWER_PROMPT),
        );
        if (reviewing) {
          const prompt = messages.map((m) => m.content ?? "").join("\n");
          reviewerPrompts.push(prompt);
          // The first look sees the sampled search; the second, the recount.
          return reviewerPrompts.length === 1
            ? { kind: "text", text: JSON.stringify({ verdict: "revise", note: NOTE }) }
            : { kind: "text", text: '{"verdict":"adequate"}' };
        }
        agentRequests.push([...messages]);
        // Sample, try to cite, recount after the refusal, cite again, answer.
        const toolTurns = messages.filter((m) => m.role === "tool").length;
        if (toolTurns === 0) {
          return {
            kind: "tool",
            name: "search_many",
            args: { queries: [{ query: "discussion" }] },
          };
        }
        if (toolTurns === 1) return CITE;
        if (toolTurns === 2) {
          return {
            kind: "tool",
            name: "search_many",
            args: { queries: [{ query: "messages today" }] },
          };
        }
        if (toolTurns === 3) return CITE;
        return { kind: "text", text: "Here is what I found." };
      },
    });
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      extraInference: {
        backends: { scripted: { type: "http", url: model.url } },
        assignments: { agent: `scripted/${MODEL_ID}` },
      },
    });
    await harness.start();
  }, 240_000);

  afterAll(async () => {
    await harness?.destroy();
    await model?.close();
  });

  test("a reviewer's rejection reaches the agent and holds its citations until it is fixed", async () => {
    const { sessionId } = await harness.gatewayJson<{ sessionId: string }>("/agent/sessions", {
      method: "POST",
      body: "{}",
    });
    await sendTurn(harness, sessionId, QUESTION);

    // The reviewer saw the request and the retrieval it was judging.
    expect(reviewerPrompts).toHaveLength(2);
    expect(reviewerPrompts[0]).toContain(QUESTION);
    expect(reviewerPrompts[0]).toContain('search_many({"queries":[{"query":"discussion"}]})');
    // The second look knows what the first retrieval already returned.
    expect(reviewerPrompts[1]).toContain('1. search_many({"queries":[{"query":"discussion"}]})');

    // The note led the first result; citing on that retrieval was refused
    // with the note; the corrected retrieval passed and carried none; and the
    // citation after it was no longer held.
    const toolMessages = agentRequests.at(-1)!.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(4);
    expect(toolMessages[0]!.content).toContain(NOTE);
    expect(toolMessages[1]!.content).toContain("retrieval_review_pending");
    expect(toolMessages[1]!.content).toContain(NOTE);
    expect(toolMessages[2]!.content).not.toContain('"review"');
    expect(toolMessages[3]!.content).not.toContain("retrieval_review_pending");

    // The persisted transcript keeps the note on the result it was attached to.
    const record = await harness.gatewayJson<ConversationRecordLike>(
      `/agent/conversations/${sessionId}`,
    );
    const reviews = (record.messages ?? [])
      .flatMap((m) => m.parts ?? [])
      .filter((part) => part.kind === "tool_result")
      .map((part) => (part.result as { review?: { note?: string } } | undefined)?.review?.note);
    expect(reviews).toEqual([NOTE, undefined, undefined, undefined]);
  });
});

async function sendTurn(
  harness: SyntheticE2EHarness,
  sessionId: string,
  text: string,
): Promise<void> {
  const sse = await fetch(`${harness.gatewayUrl}/agent/events`, {
    headers: { Authorization: `Bearer ${harness.apiKey}`, Accept: "text/event-stream" },
  });
  if (!sse.ok || !sse.body) throw new Error(`SSE subscribe failed: ${sse.status}`);
  const reader = sse.body.getReader();
  try {
    const sent = await harness.gatewayJson<{ messageId: string }>(
      `/agent/sessions/${sessionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ text }),
      },
    );
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf("\n\n");
      while (cut !== -1) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf("\n\n");
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let event: { type?: string; payload?: Record<string, unknown> };
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        const payload = event.payload ?? {};
        if (payload.sessionId !== sessionId) continue;
        if (event.type === "agent.error")
          throw new Error(`agent error: ${JSON.stringify(payload)}`);
        if (event.type === "agent.message.end" && payload.messageId === sent.messageId) {
          if (payload.stopReason === "tool_use") continue;
          return;
        }
      }
    }
    throw new Error(`turn did not complete within ${TURN_TIMEOUT_MS}ms`);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best effort */
    }
  }
}
