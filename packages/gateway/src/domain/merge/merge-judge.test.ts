// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLogger, type DecisionCapability, type DecisionRequest } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import {
  applyMergeAdjudication,
  listAllMergeCandidates,
  upsertMergeCandidates,
} from "../../merge-candidates.js";
import { listMergeRules } from "../../people.js";
import {
  MERGE_JUDGE_INDIVIDUALS_ID,
  MERGE_JUDGE_QUESTION_ID,
  buildMergeJudgeRequest,
  listMergeJudgeWork,
  mergeJudgeVerdict,
  runMergeJudgePass,
  type MergeJudgeMode,
} from "./merge-judge.js";
import type Database from "better-sqlite3";

let tmpDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-merge-judge-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makePerson(name: string, email: string, isSelf = false): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, 'extracted', ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, name, isSelf ? 1 : 0);
  db.prepare(
    `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at) VALUES (?, ?, ?, 'email', '2026-01-01')`,
  ).run(randomUUID(), id, email);
  db.prepare(
    `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at, occurrence_count, is_primary)
     VALUES (?, ?, ?, 'name', '2026-01-01', 1, 1)`,
  ).run(randomUUID(), id, name);
  return id;
}

function personWithEmail(email: string): string {
  return db
    .prepare<[string], { person_id: string }>(
      "SELECT person_id FROM person_aliases WHERE alias = ? AND alias_type = 'email'",
    )
    .get(email)!.person_id;
}

/** A pending candidate between two people's email addresses. */
function candidate(a: string, b: string): string {
  upsertMergeCandidates(db, [
    {
      sideA: { aliasType: "email", alias: a },
      sideB: { aliasType: "email", alias: b },
      score: 0.9,
      detectionKind: "name_token_overlap",
      matchedTokens: ["maya", "reeves"],
      matchStrength: 1.7,
      personA: personWithEmail(a),
      personB: personWithEmail(b),
    },
  ]);
  const row = listAllMergeCandidates(db, "pending").find((c) =>
    [c.sideA.alias, c.sideB.alias].includes(a),
  );
  if (!row) throw new Error("candidate not seeded");
  return row.id;
}

/** A decision model scoring each request by an address its evidence carries: [same person, both individuals]. */
function judge(scores: Record<string, readonly [number, number] | Error>) {
  const requests: DecisionRequest[] = [];
  const model: DecisionCapability = {
    modelId: "decision-scripted-v1",
    async decide(request) {
      requests.push(request);
      const state = String(request.state);
      const hit = Object.entries(scores).find(([marker]) => state.includes(marker));
      if (!hit) throw new Error("unscripted request");
      if (hit[1] instanceof Error) throw hit[1];
      return {
        model: "decision-scripted-v1",
        answers: {
          [MERGE_JUDGE_QUESTION_ID]: { type: "score", score: hit[1][0] },
          [MERGE_JUDGE_INDIVIDUALS_ID]: { type: "score", score: hit[1][1] },
        },
        inputTokens: 120,
      };
    },
    dispose() {},
  };
  return { model, requests };
}

function pass(
  mode: MergeJudgeMode,
  decision: DecisionCapability | null,
  shadowSeen = new Set<string>(),
) {
  const spend: number[] = [];
  return {
    spend,
    run: () =>
      runMergeJudgePass({
        mode,
        decision,
        listWork: (limit) => Promise.resolve(listMergeJudgeWork(db, limit)),
        apply: (input) => Promise.resolve(applyMergeAdjudication(db, input)),
        recordSpend: (_model, tokens) => {
          spend.push(tokens);
          return Promise.resolve();
        },
        log: createLogger("test:merge-judge"),
        shadowSeen,
      }),
  };
}

const status = (id: string) =>
  db
    .prepare<[string], { status: string; adjudication_verdict: string | null }>(
      "SELECT status, adjudication_verdict FROM merge_candidates WHERE id = ?",
    )
    .get(id)!;

describe("mergeJudgeVerdict", () => {
  test("two individuals merge on a clear same-person score and are dismissed on a clear different one", () => {
    expect(mergeJudgeVerdict(4, 1)).toBe("merge");
    expect(mergeJudgeVerdict(3, 0.8)).toBe("merge");
    expect(mergeJudgeVerdict(2.9, 1)).toBe("unsure");
    expect(mergeJudgeVerdict(1, 1)).toBe("unsure");
    expect(mergeJudgeVerdict(0.6, 1)).toBe("unsure");
    expect(mergeJudgeVerdict(0.5, 1)).toBe("distinct");
  });

  test("a side that is not a person is dismissed, however alike they look", () => {
    expect(mergeJudgeVerdict(3.6, 0.05)).toBe("distinct");
    expect(mergeJudgeVerdict(3.6, 0.1)).toBe("distinct");
    // Not clearly individuals, not clearly not: neither merged nor dismissed.
    expect(mergeJudgeVerdict(3.6, 0.3)).toBe("unsure");
    expect(mergeJudgeVerdict(0.8, 0.29)).toBe("unsure");
  });
});

describe("buildMergeJudgeRequest", () => {
  test("asks whether both sides are people, and whether they are the same one", () => {
    const request = buildMergeJudgeRequest("evidence text");
    expect(request.state).toBe("evidence text");
    const same = request.questions[MERGE_JUDGE_QUESTION_ID];
    const individuals = request.questions[MERGE_JUDGE_INDIVIDUALS_ID];
    expect(same?.type === "score" && same.criteria).toHaveLength(5);
    expect(individuals?.type === "score" && individuals.criteria).toHaveLength(2);
  });
});

describe("runMergeJudgePass", () => {
  test("enforce merges the same person, dismisses different people and leaves the rest", async () => {
    makePerson("Maya Reeves", "maya.reeves@example.com");
    makePerson("Maya Reeves", "mreeves@example.org");
    makePerson("Alex Chen", "alex.chen@northstar.example");
    makePerson("Alex Rivera", "alex.rivera@northstar.example");
    makePerson("Jamie Lopez", "jamie@example.com");
    makePerson("Jamie Lopez", "jlopez@example.org");
    const same = candidate("maya.reeves@example.com", "mreeves@example.org");
    const different = candidate("alex.chen@northstar.example", "alex.rivera@northstar.example");
    const unclear = candidate("jamie@example.com", "jlopez@example.org");
    const { model, requests } = judge({
      mreeves: [3.9, 0.95],
      "alex.rivera": [0.2, 0.9],
      jlopez: [2, 0.9],
    });

    const { run, spend } = pass("enforce", model);
    const res = await run();

    expect(res).toMatchObject({ judged: 3, merge: 1, distinct: 1, unsure: 1, unavailable: 0 });
    expect(requests).toHaveLength(3);
    expect(spend).toEqual([120, 120, 120]);
    expect(status(same).status).toBe("accepted");
    expect(status(different).status).toBe("denied");
    expect(status(unclear)).toEqual({ status: "pending", adjudication_verdict: "unsure" });
    const rule = listMergeRules(db, { active: true });
    expect(rule).toHaveLength(1);
    expect(rule[0]!.kind).toBe("system");
    expect(rule[0]!.reason).toContain("decision-scripted-v1 judged these to be the same person");

    // A judged candidate is not asked again while its evidence stands.
    expect((await run()).judged).toBe(0);
    expect(requests).toHaveLength(3);
  });

  test("a person and their newsletter sender are dismissed, however alike they score", async () => {
    makePerson("Maya Reeves", "maya.reeves@example.com");
    makePerson("Maya Reeves", "news@example.org");
    const id = candidate("maya.reeves@example.com", "news@example.org");
    const { model } = judge({ "news@": [3.6, 0.1] });

    expect((await pass("enforce", model).run()).distinct).toBe(1);
    expect(status(id).status).toBe("denied");
    expect(listMergeRules(db, { active: true })).toHaveLength(0);
  });

  test("shadow asks and changes nothing, and does not ask the same evidence twice", async () => {
    makePerson("Maya Reeves", "maya.reeves@example.com");
    makePerson("Maya Reeves", "mreeves@example.org");
    const id = candidate("maya.reeves@example.com", "mreeves@example.org");
    const { model, requests } = judge({ mreeves: [4, 1] });
    const seen = new Set<string>();

    expect((await pass("shadow", model, seen).run()).merge).toBe(1);
    expect(status(id)).toEqual({ status: "pending", adjudication_verdict: null });
    expect(listMergeRules(db, { active: true })).toHaveLength(0);
    await pass("shadow", model, seen).run();
    expect(requests).toHaveLength(1);
  });

  test("an unanswered judgement leaves the candidate pending and due", async () => {
    makePerson("Maya Reeves", "maya.reeves@example.com");
    makePerson("Maya Reeves", "mreeves@example.org");
    const id = candidate("maya.reeves@example.com", "mreeves@example.org");
    const { model } = judge({ mreeves: new Error("503") });

    const res = await pass("enforce", model).run();

    expect(res).toMatchObject({ judged: 0, unavailable: 1 });
    expect(status(id)).toEqual({ status: "pending", adjudication_verdict: null });
  });

  test("never judges a candidate that touches self, and does nothing when off or unassigned", async () => {
    makePerson("Maya Reeves", "maya.reeves@example.com", true);
    makePerson("Maya Reeves", "mreeves@example.org");
    const id = candidate("maya.reeves@example.com", "mreeves@example.org");
    const { model, requests } = judge({ mreeves: [4, 1] });

    expect((await pass("enforce", model).run()).judged).toBe(0);
    expect((await pass("off", model).run()).judged).toBe(0);
    expect((await pass("enforce", null).run()).judged).toBe(0);
    expect(requests).toHaveLength(0);
    expect(status(id).status).toBe("pending");
  });
});
