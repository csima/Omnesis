// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The merge judge — the decision model decides whether a merge candidate's two
 * sides are the same human being.
 *
 * The fuzzy detector only proposes: name tokens shared across two records say
 * that they might be one person, never that they are. Two people who share a
 * first name and an employer look alike to it, and a structural rule for each
 * such case is a rule that misfires on the next. So each pending candidate's
 * evidence pack (`buildMergeAdjudicationEvidence`: both sides' names and
 * identifiers, recent documents, shared threads, co-interactors) goes to the
 * decision model with two questions: whether both sides are individual people
 * at all, and whether they are the same one. The answers settle the candidate:
 *
 *   - two individuals and the same person → a reversible system merge rule,
 *     whose reason names the model and its scores;
 *   - different people, or a side that is not a person (a meeting room, a list,
 *     a role mailbox, a newsletter) → the candidate is denied, so the pair stops
 *     returning;
 *   - anything between → it stays pending for the operator, with the verdict
 *     recorded on it.
 *
 * Verdicts go through `applyMergeAdjudication`, so the writer's guards still
 * hold whatever the model answers: self stays manual, a shared mailbox is never
 * welded, and a side that resolved differently by the time the verdict lands is
 * not merged. A model that does not answer leaves the candidate untouched.
 *
 * `shadow` asks and logs without acting, so the verdicts can be read against a
 * live corpus before they are allowed to merge anything.
 */

import { askScore } from "../../brain/decision-call.js";
import { buildMergeAdjudicationEvidence } from "../../brain/merge-adjudication.js";
import { fetchSelfPersonId } from "../InteractionScoreService.js";
import {
  currentEvidenceFingerprint,
  isAdjudicationDue,
  listAllMergeCandidates,
  type ApplyMergeAdjudicationInput,
  type ApplyMergeAdjudicationResult,
  type MergeAdjudicationVerdict,
} from "../../merge-candidates.js";
import { resolveAliasSide } from "../../people.js";
import type Database from "better-sqlite3";
import type { DecisionCapability, DecisionRequest, Logger } from "@omnesis/core";

type Db = Database.Database;

export type MergeJudgeMode = "off" | "shadow" | "enforce";

/** Candidates judged per pass; the next pass takes the rest. */
export const MERGE_JUDGE_MAX_PER_PASS = 25;

export const MERGE_JUDGE_QUESTION_ID = "samePerson";
export const MERGE_JUDGE_INDIVIDUALS_ID = "individuals";

/** Levels of the same-person question, lowest first. */
const SAME_PERSON_LEVELS = [
  "Different people.",
  "Probably different people. They share a common name, a surname, an employer or an email domain, but nothing specific to one individual.",
  "Cannot tell from this evidence.",
  "Probably the same person. They share something specific to one individual, such as the same full name with a matching personal address, or the same conversations.",
  "The same person: one individual seen under different addresses, names or accounts, with evidence specific to them.",
] as const;

/**
 * Whether both sides are people at all. Asked apart from the same-person
 * question, because a newsletter sender, a meeting room or a role mailbox can
 * look very like the person it belongs to and still must never be merged into
 * them.
 */
const INDIVIDUALS_LEVELS = [
  "At least one side is not an individual person: a meeting room or resource calendar, a mailing list or group, a role or team mailbox, an organisation or business, or a sender that posts on behalf of a platform, an event or a publication (a newsletter, an event calendar, a community or booking service, a marketing sender).",
  "Both sides are individual people.",
] as const;

/** Same-person score at or above which two individuals are merged, and at or below which they are dismissed. */
export const MERGE_JUDGE_SAME_AT = 3;
export const MERGE_JUDGE_DIFFERENT_AT = 1;
/** Probability that both sides are individuals, at or below which the pair is dismissed, and at or above which it may merge. */
export const MERGE_JUDGE_NOT_INDIVIDUALS_AT = 0.3;
export const MERGE_JUDGE_INDIVIDUALS_AT = 0.8;

export function buildMergeJudgeRequest(evidence: string): DecisionRequest {
  return {
    state: evidence,
    questions: {
      [MERGE_JUDGE_INDIVIDUALS_ID]: {
        type: "score",
        instructions:
          "These two records come from one person's own email, chat, calendar and contacts. Judge from the evidence whether side A and side B are each an individual human being. A record known only by an address, with no display name, is still an individual when the address and the documents read as one person's.",
        criteria: INDIVIDUALS_LEVELS,
      },
      [MERGE_JUDGE_QUESTION_ID]: {
        type: "score",
        instructions:
          "A matcher has proposed that these two records describe the same human being. Judge from the evidence whether side A and side B are the same individual. Sharing a first name, a surname, an employer or an email domain does not make two people the same; one person's work and personal addresses, or their addresses at an old and a new employer, are the same person.",
        criteria: SAME_PERSON_LEVELS,
      },
    },
  };
}

const VERDICT_REASON: Record<MergeAdjudicationVerdict, string> = {
  merge: "these to be the same person",
  distinct: "these to be different people",
  unsure: "that the evidence cannot tell whether these are the same person",
};

/**
 * The verdict from both answers. A pair where either side is not a person is
 * dismissed whatever else matches; two individuals merge only on a clear
 * same-person score, and are dismissed on a clear different-people one.
 */
export function mergeJudgeVerdict(
  samePerson: number,
  individuals: number,
): MergeAdjudicationVerdict {
  if (individuals <= MERGE_JUDGE_NOT_INDIVIDUALS_AT) return "distinct";
  if (samePerson <= MERGE_JUDGE_DIFFERENT_AT) return "distinct";
  if (samePerson >= MERGE_JUDGE_SAME_AT && individuals >= MERGE_JUDGE_INDIVIDUALS_AT)
    return "merge";
  return "unsure";
}

/** One candidate ready to judge: its evidence, and what the verdict will be bound to. */
export interface MergeJudgeWork {
  candidateId: string;
  evidence: string;
  evidenceFingerprint: string;
  /** The person ids both sides resolved to when the evidence was built. */
  personIds: string[];
}

/**
 * The pending candidates due a judgement, oldest evidence first, with their
 * evidence packs. Read-only; runs on a read worker. A candidate that touches
 * self is skipped: a wrong self-merge corrupts every first-person answer, so
 * self stays with the operator.
 */
export function listMergeJudgeWork(db: Db, limit: number): MergeJudgeWork[] {
  const selfId = fetchSelfPersonId(db);
  const due = listAllMergeCandidates(db, "pending")
    .filter((c) => isAdjudicationDue(c))
    .sort((x, y) => x.detectedAt.localeCompare(y.detectedAt));
  const work: MergeJudgeWork[] = [];
  for (const cand of due) {
    if (work.length >= limit) break;
    const personIds = [
      ...new Set([cand.sideA, cand.sideB].flatMap((s) => resolveAliasSide(db, s).map((p) => p.id))),
    ];
    if (personIds.length < 2) continue;
    if (selfId && personIds.includes(selfId)) continue;
    work.push({
      candidateId: cand.id,
      evidence: buildMergeAdjudicationEvidence(db, cand),
      evidenceFingerprint: currentEvidenceFingerprint(cand),
      personIds,
    });
  }
  return work;
}

export interface MergeJudgePassDeps {
  mode: MergeJudgeMode;
  decision: DecisionCapability | null;
  listWork: (limit: number) => Promise<MergeJudgeWork[]>;
  apply: (input: ApplyMergeAdjudicationInput) => Promise<ApplyMergeAdjudicationResult>;
  recordSpend: (modelId: string, inputTokens: number) => Promise<void>;
  log: Logger;
  /** Evidence already judged in shadow this process, so a pass does not re-ask it. */
  shadowSeen: Set<string>;
  maxPerPass?: number;
}

export interface MergeJudgePassResult {
  judged: number;
  merge: number;
  distinct: number;
  unsure: number;
  unavailable: number;
}

export async function runMergeJudgePass(deps: MergeJudgePassDeps): Promise<MergeJudgePassResult> {
  const result: MergeJudgePassResult = {
    judged: 0,
    merge: 0,
    distinct: 0,
    unsure: 0,
    unavailable: 0,
  };
  if (deps.mode === "off" || !deps.decision) return result;
  const limit = deps.maxPerPass ?? MERGE_JUDGE_MAX_PER_PASS;
  const shadow = deps.mode === "shadow";
  // Shadow keeps nothing on the candidate, so it asks for more than it judges
  // and skips what it has already seen.
  const work = (await deps.listWork(shadow ? limit + deps.shadowSeen.size : limit))
    .filter((w) => !shadow || !deps.shadowSeen.has(`${w.candidateId}:${w.evidenceFingerprint}`))
    .slice(0, limit);
  for (const w of work) {
    const judgement = await askScore(
      deps.decision,
      buildMergeJudgeRequest(w.evidence),
      MERGE_JUDGE_QUESTION_ID,
      {
        recordSpend: deps.recordSpend,
        log: deps.log,
        additionalQuestionIds: [MERGE_JUDGE_INDIVIDUALS_ID],
      },
    );
    const individuals = judgement.additionalScores?.[MERGE_JUDGE_INDIVIDUALS_ID];
    if (judgement.score === null || individuals === undefined) {
      // Fail open: the candidate stays pending and due, for the next pass.
      result.unavailable += 1;
      continue;
    }
    const verdict = mergeJudgeVerdict(judgement.score, individuals);
    result.judged += 1;
    result[verdict] += 1;
    const score = `${judgement.score.toFixed(2)}/4, individuals ${individuals.toFixed(2)}`;
    if (shadow) {
      deps.shadowSeen.add(`${w.candidateId}:${w.evidenceFingerprint}`);
      deps.log.info(
        `merge judge (shadow): candidate ${w.candidateId} → ${verdict} (score ${score}, ${judgement.modelId})`,
      );
      continue;
    }
    const applied = await deps.apply({
      candidateId: w.candidateId,
      verdict,
      reason: `${judgement.modelId} judged ${VERDICT_REASON[verdict]} (same-person score ${judgement.score.toFixed(2)} of 4; both individuals ${individuals.toFixed(2)}).`,
      runId: `merge-judge:${judgement.modelId}`,
      expectedPersonIds: w.personIds,
      judgedEvidenceFingerprint: w.evidenceFingerprint,
    });
    deps.log.info(
      `merge judge: candidate ${w.candidateId} → ${verdict} (score ${score}, ${applied.outcome})`,
    );
  }
  if (result.judged > 0 || result.unavailable > 0) {
    deps.log.info(
      `merge judge${shadow ? " (shadow)" : ""}: ${result.judged} judged — ${result.merge} same, ${result.distinct} different, ${result.unsure} unsure; ${result.unavailable} unanswered`,
    );
  }
  return result;
}
