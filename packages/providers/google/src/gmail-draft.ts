// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

/**
 * The external id of a Gmail draft's document. A draft is indexed under its own
 * id, never its message's: the message id is what the sent mail keeps once the
 * draft is sent, and the sent mail is a document of its own.
 */
export function gmailDraftExternalId(draftId: string): string {
  return `gmail-draft:${draftId}`;
}
