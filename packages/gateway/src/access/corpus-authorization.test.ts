// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import {
  createCorpusAuthorization,
  externalAnswerOwnerId,
  parseCorpusAuthorization,
  serializeCorpusAuthorization,
} from "./corpus-authorization.js";

const identity = {
  principalId: "principal-example",
  grantId: "grant-example",
  grantRevision: 3,
  credentialId: "credential-example",
  accessTokenId: "token-example",
};

describe("corpus authorization", () => {
  test("normalizes allowlists into a deterministic immutable scope", () => {
    const first = createCorpusAuthorization(
      identity,
      [
        {
          capability: "direct",
          sourceMode: "allowlist",
          sourceIds: ["mail:beta", "mail:alpha", "mail:alpha"],
          releaseMode: null,
          policyFamilyId: null,
          policyRevision: null,
          privacyPolicy: null,
        },
      ],
      "direct",
    )!;
    const second = createCorpusAuthorization(
      identity,
      [
        {
          capability: "direct",
          sourceMode: "allowlist",
          sourceIds: ["mail:alpha", "mail:beta"],
          releaseMode: null,
          policyFamilyId: null,
          policyRevision: null,
          privacyPolicy: null,
        },
      ],
      "direct",
    )!;

    expect(first.sourceIds).toEqual(["mail:alpha", "mail:beta"]);
    expect(first.digest).toBe(second.digest);
    expect(first.allowsSource("mail:alpha")).toBe(true);
    expect(first.allowsSource("mail:future")).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.sourceIds)).toBe(true);
  });

  test("denylist automatically admits a future source while retaining its exclusion", () => {
    const authorization = createCorpusAuthorization(
      identity,
      [
        {
          capability: "answer",
          sourceMode: "denylist",
          sourceIds: ["mail:denied"],
          releaseMode: "reviewed",
          policyFamilyId: "policy-family-example",
          policyRevision: "policy-revision-example",
          privacyPolicy: "policy-v2",
        },
      ],
      "answer",
    )!;

    expect(authorization.allowsSource("mail:denied")).toBe(false);
    expect(authorization.allowsSource("mail:future")).toBe(true);
    expect(parseCorpusAuthorization(serializeCorpusAuthorization(authorization)).digest).toBe(
      authorization.digest,
    );
  });

  test("keeps Answer ownership stable across token and policy revisions but partitions corpus scope", () => {
    const authorization = createCorpusAuthorization(
      identity,
      [
        {
          capability: "answer",
          sourceMode: "allowlist",
          sourceIds: ["notes:primary"],
          releaseMode: "reviewed",
          policyFamilyId: "policy-family-example",
          policyRevision: "policy-revision-one",
          privacyPolicy: "Fictional first policy.",
        },
      ],
      "answer",
    )!;

    expect(externalAnswerOwnerId(authorization)).toContain("grant:grant-example:credential:");
    expect(externalAnswerOwnerId(authorization)).toContain(
      "credential:credential-example:answer-scope:",
    );
    const revisedPolicy = createCorpusAuthorization(
      { ...identity, grantRevision: 4, accessTokenId: "token-next" },
      [
        {
          capability: "answer",
          sourceMode: "allowlist",
          sourceIds: ["notes:primary"],
          releaseMode: "reviewed",
          policyFamilyId: "policy-family-example",
          policyRevision: "policy-revision-two",
          privacyPolicy: "Fictional revised policy.",
        },
      ],
      "answer",
    )!;
    const changedSources = createCorpusAuthorization(
      identity,
      [
        {
          capability: "answer",
          sourceMode: "allowlist",
          sourceIds: ["notes:secondary"],
          releaseMode: "reviewed",
          policyFamilyId: "policy-family-example",
          policyRevision: "policy-revision-one",
          privacyPolicy: "Fictional first policy.",
        },
      ],
      "answer",
    )!;

    expect(externalAnswerOwnerId(revisedPolicy)).toBe(externalAnswerOwnerId(authorization));
    expect(externalAnswerOwnerId(changedSources)).not.toBe(externalAnswerOwnerId(authorization));
  });

  test("gives each agent of an agent host, acting for each person, its own Answer owner", () => {
    const authorization = createCorpusAuthorization(
      identity,
      [
        {
          capability: "answer",
          sourceMode: "all",
          sourceIds: [],
          releaseMode: "unreviewed",
          policyFamilyId: null,
          policyRevision: null,
          privacyPolicy: null,
        },
      ],
      "answer",
    )!;
    const unbound = externalAnswerOwnerId(authorization);
    const caller = {
      issuer: "https://agents.example.org",
      person: "maya.reeves@example.com",
      agent: "instance:researcher-1",
    };
    const researcher = externalAnswerOwnerId(authorization, caller);
    const planner = externalAnswerOwnerId(authorization, {
      ...caller,
      agent: "instance:planner-7",
    });
    const forAnotherPerson = externalAnswerOwnerId(authorization, {
      ...caller,
      person: "jamie.lopez@example.com",
    });
    const fromAnotherHost = externalAnswerOwnerId(authorization, {
      ...caller,
      issuer: "https://agents.example.net",
    });

    expect(unbound).toMatch(
      /^principal:principal-example:grant:grant-example:credential:credential-example:answer-scope:[A-Za-z0-9_-]+$/,
    );
    expect(researcher).toMatch(new RegExp(`^${unbound}:host:[A-Za-z0-9_-]+$`));
    expect(new Set([unbound, researcher, planner, forAnotherPerson, fromAnotherHost]).size).toBe(5);
    expect(researcher).not.toContain("maya.reeves");
    expect(externalAnswerOwnerId(authorization, { ...caller })).toBe(researcher);
  });

  test("fails closed for a stored empty allowlist and normalizes an empty denylist", () => {
    const emptyAllowlist = createCorpusAuthorization(
      identity,
      [
        {
          capability: "answer",
          sourceMode: "allowlist",
          sourceIds: [],
          releaseMode: "unreviewed",
          policyFamilyId: null,
          policyRevision: null,
          privacyPolicy: null,
        },
      ],
      "answer",
    )!;
    const emptyDenylist = createCorpusAuthorization(
      identity,
      [
        {
          capability: "direct",
          sourceMode: "denylist",
          sourceIds: [],
          releaseMode: null,
          policyFamilyId: null,
          policyRevision: null,
          privacyPolicy: null,
        },
      ],
      "direct",
    )!;

    expect(emptyAllowlist.allowsSource("mail:future")).toBe(false);
    expect(emptyDenylist.allowsSource("mail:future")).toBe(true);
    expect(emptyDenylist.sourceMode).toBe("all");
    expect(emptyDenylist.restricted).toBe(false);
  });

  test("rejects malformed Answer release state instead of inferring access", () => {
    expect(() =>
      createCorpusAuthorization(
        identity,
        [
          {
            capability: "answer",
            sourceMode: "all",
            sourceIds: [],
            releaseMode: "unreviewed",
            policyFamilyId: "policy-family-example",
            policyRevision: "policy-revision-example",
            privacyPolicy: null,
          },
        ],
        "answer",
      ),
    ).toThrow("valid release mode");
  });
  test("Notes cannot become corpus read authority", () => {
    const notes = {
      capability: "notes" as const,
      sourceMode: "all" as const,
      sourceIds: [],
      releaseMode: null,
      policyFamilyId: null,
      policyRevision: null,
      privacyPolicy: null,
    };
    expect(createCorpusAuthorization(identity, [notes], "answer")).toBeNull();
    expect(createCorpusAuthorization(identity, [notes], "direct")).toBeNull();
    expect(
      // @ts-expect-error Runtime callers cannot turn append-only authority into read access.
      createCorpusAuthorization(identity, [notes], "notes"),
    ).toBeNull();
  });
});
