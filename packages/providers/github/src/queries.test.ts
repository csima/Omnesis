// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  PR_REVIEWS_PAGE_QUERY,
  THREAD_COMMENTS_PAGE_QUERY,
  buildThreadBatchQuery,
} from "./queries.js";

describe("thread queries request the identifiers the documents emit", () => {
  const batch = buildThreadBatchQuery(1);

  it("selects node ids, head sha, review requests and review threads", () => {
    expect(batch).toMatch(/fragment IssueF on Issue \{[^}]*__typename id number/);
    expect(batch).toMatch(/fragment PrF on PullRequest \{[^]*__typename id number/);
    expect(batch).toContain("headRefOid");
    expect(batch).toContain("reviewRequests(first: 10)");
    expect(batch).toContain("... on Team { combinedSlug }");
    expect(batch).toContain("reviewThreads(first: 20) { nodes { id } }");
    expect(batch).toContain("stateReason");
  });

  it("selects the id of every comment, review and inline review comment", () => {
    expect(batch).toMatch(/comments\(first: 40\) \{[^]*?nodes \{ id author/);
    expect(batch).toMatch(/reviews\(first: 25\) \{[^]*?nodes \{\s*id author/);
    expect(batch).toMatch(/reviews\(first: 25\)[^]*?comments\(first: 15\)[^]*?nodes \{ id author/);
  });

  it("the overflow pages select the same ids", () => {
    expect(THREAD_COMMENTS_PAGE_QUERY).toMatch(/nodes \{ id author/);
    expect(PR_REVIEWS_PAGE_QUERY).toMatch(/nodes \{\s*id author/);
    expect(PR_REVIEWS_PAGE_QUERY).toMatch(/comments\(first: 15\)[^]*?nodes \{ id author/);
  });
});
