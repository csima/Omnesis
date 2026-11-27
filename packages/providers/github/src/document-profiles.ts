// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DocumentEventProfile, DocumentMetadataFieldSpec } from "@omnesis/source-sdk";

/**
 * Which repository a document belongs to. Shared by both sources.
 *
 * A personal repository is spelled `<login>/<name>`, so a filter on this
 * field can single out a person as surely as an author filter does.
 */
const repoField = {
  path: "extra.repo",
  type: "string",
  description:
    "Repository the document belongs to, spelled owner/name exactly as it appears in the GitHub URL (for example acme/widgets).",
  identifiesPeople: true,
} satisfies DocumentMetadataFieldSpec;

/**
 * GitHub threads: one conversation document per issue, pull request, or
 * discussion, carrying its comments and reviews.
 *
 * Deliberately undeclared: `extra.links` (same-source external ids, an
 * internal linking convention), `extra.commentCount` (a count the predicate
 * grammar can only test for equality, never as a threshold), `sourceUrl` and
 * `rollingAggregate` (every document carries them).
 */
export const githubThreadsDocumentProfile: DocumentEventProfile = {
  documentTypes: ["conversation"],
  personRoles: ["author", "participant", "mentioned"],
  metadataFields: [
    {
      path: "extra.kind",
      type: "string",
      description:
        "Which kind of thread the document is. A thread's kind never changes, so a new issue or a new pull request is a created event whose kind matches.",
      allowedValues: ["issue", "pull-request", "discussion"],
      valueAliases: {
        issue: ["issues", "bug report", "ticket", "feature request"],
        "pull-request": ["pull requests", "PR", "PRs", "merge request", "patch"],
        discussion: ["discussions", "forum thread", "Q&A"],
      },
    },
    {
      path: "status",
      type: "string",
      description:
        "Lifecycle state of the thread. An issue is open or closed. A pull request is open, draft, merged, or closed without being merged. A discussion is answered or unanswered.",
      allowedValues: ["open", "closed", "merged", "draft", "answered", "unanswered"],
      valueAliases: {
        open: ["still open", "not yet closed"],
        closed: ["closed out", "closed without merging"],
        merged: ["landed", "merged in", "shipped"],
        draft: ["draft PR", "work in progress", "WIP"],
        answered: ["has an accepted answer", "solved"],
        unanswered: ["no accepted answer", "awaiting an answer"],
      },
    },
    repoField,
    {
      path: "extra.number",
      type: "number",
      description: "The thread's number within its repository, as shown at the end of its URL.",
    },
    {
      path: "tags",
      type: "string-array",
      description:
        "Labels applied to an issue or pull request, using the repository's own label names. Absent when the thread has no labels; discussions never carry any.",
    },
    {
      path: "extra.nodeId",
      type: "string",
      description:
        "GitHub's global GraphQL node id of the issue or pull request, the identifier a mutation names. Opaque: never shown to a person and never parsed for meaning. Absent on discussions.",
    },
    {
      path: "extra.headSha",
      type: "string",
      description:
        "Full sha of the head commit of a pull request's branch as last synced. A pull request only; absent on issues and discussions. Opaque.",
    },
    {
      path: "extra.stateReason",
      type: "string",
      description:
        "Why an issue is in its state, in GitHub's own words lowercased: completed or not_planned once closed, reopened after it was opened again. An issue only; absent while it has never been closed.",
      canonicalValues: ["completed", "not_planned", "reopened", "duplicate"],
      valueAliases: {
        completed: ["done", "resolved", "fixed"],
        not_planned: ["won't fix", "wontfix", "declined"],
        reopened: ["opened again"],
      },
    },
    {
      path: "extra.assignees",
      type: "string-array",
      identifiesPeople: true,
      description:
        "GitHub logins the issue or pull request is assigned to. Absent when nobody is assigned.",
    },
    {
      path: "extra.requestedReviewers",
      type: "string-array",
      identifiesPeople: true,
      description:
        "Who a pull request is still waiting on for review: user logins, and teams as org/team-slug. Absent when no review is requested and on issues.",
    },
    {
      path: "extra.commentIds",
      type: "string-array",
      description:
        "Node ids of the thread's conversation comments, oldest first, at most the newest 100. The identifiers a reply or edit names. Opaque.",
    },
    {
      path: "extra.reviewIds",
      type: "string-array",
      description:
        "Node ids of a pull request's submitted and pending reviews, oldest first, at most the newest 100. Opaque.",
    },
    {
      path: "extra.reviewCommentIds",
      type: "string-array",
      description:
        "Node ids of the inline review comments fetched with the pull request's reviews, at most the newest 100. Opaque.",
    },
    {
      path: "extra.reviewThreadIds",
      type: "string-array",
      description:
        "Node ids of a pull request's inline review threads, the identifiers a resolve names; at most the first 20 are fetched. Opaque.",
    },
    {
      path: "extra.authorIsSelf",
      type: "boolean",
      description:
        "True when the account owner opened the issue or pull request, false when someone else did. Absent when the account's login is not known.",
    },
    {
      path: "extra.reviewRequestedFromSelf",
      type: "boolean",
      description:
        "True when a review of the pull request is requested from the account owner by name (a team request does not count). A pull request only.",
    },
    {
      path: "extra.mentionsSelf",
      type: "boolean",
      description:
        "True when the issue or pull request's body, a comment or a review @-mentions the account owner, outside code. Absent when the account's login is not known.",
    },
  ],
};

/**
 * GitHub commits: one document per commit on a repository's default branch,
 * carrying the message, the author, the change stats and the touched paths.
 *
 * Deliberately undeclared: `extra.sha` (an opaque hash that nobody spells in
 * full, and the predicate grammar has no prefix match), `extra.filesChanged`
 * (a count, testable only for equality) and `extra.kind` (always `commit`).
 */
export const githubCommitsDocumentProfile: DocumentEventProfile = {
  documentTypes: ["document"],
  personRoles: ["author", "participant", "mentioned"],
  metadataFields: [
    repoField,
    {
      path: "extra.mergeCommit",
      type: "boolean",
      description:
        "Present and true only on a merge commit, one with more than one parent. Absent on every other commit, so 'exists' is the test for it.",
    },
    {
      path: "extra.authorIsSelf",
      type: "boolean",
      description:
        "True when the account owner authored the commit (by GitHub login or noreply address), false when someone else did. Absent when the account's login is not known.",
    },
  ],
};
