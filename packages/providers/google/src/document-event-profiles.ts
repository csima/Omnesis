// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the Google sources' documents can be asked about — the document-side
 * counterpart of the analytics schemas' categorical vocabularies.
 *
 * Every entry below describes the wire contract of the normalizers in
 * `gmail.ts` / `calendar.ts`: the document types they emit, the person roles
 * they really assert, and the metadata they really populate. A declaration
 * the normalizer does not honour would let a natural-language condition
 * compile into a predicate that can never match, so the values here are held
 * to what those files write, and `document-event-profiles.test.ts` pins them
 * to the normalizers' actual output.
 */

import type { DocumentEventProfile } from "@omnesis/source-sdk";

/**
 * Gmail's built-in labels. Gmail returns these labels with `name` equal to
 * their `id`, so the resolved `metadata.tags` entry is the uppercase
 * identifier itself rather than the title-case string the web UI shows.
 * The vocabulary is open rather than closed: every user-created label
 * resolves to its own name and lands in the same array.
 *
 * SPAM and TRASH are deliberately absent — those messages are dropped during
 * normalization, so no indexed document ever carries either label.
 */
const GMAIL_SYSTEM_LABELS = [
  "INBOX",
  "SENT",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
];

export const gmailDocumentEventProfile: DocumentEventProfile = {
  // One document per message, plus one child document per attachment whose
  // text was successfully extracted.
  documentTypes: ["email", "attachment"],
  // `From` becomes the sender, `To` + `Cc` become recipients, and email
  // addresses or phone numbers found in the body become mentions. An
  // attachment document inherits the sender and recipients of its message and
  // takes its mentions from its own extracted text.
  personRoles: ["sender", "recipient", "mentioned"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description:
        "Gmail labels on the message, resolved to their names. Built-in labels appear as their uppercase identifiers (INBOX, STARRED, CATEGORY_PROMOTIONS); a user-created label appears as the name its owner gave it, and a nested one as a slash path such as 'Receipts/2026'. Attachment documents carry no labels.",
      canonicalValues: GMAIL_SYSTEM_LABELS,
      valueAliases: {
        INBOX: ["inbox", "in the inbox"],
        SENT: ["sent", "sent mail", "mail I sent"],
        UNREAD: ["unread", "not yet read"],
        STARRED: ["starred", "flagged"],
        IMPORTANT: ["important", "marked important"],
        CATEGORY_PERSONAL: ["primary", "primary tab", "personal tab"],
        CATEGORY_SOCIAL: ["social", "social tab"],
        CATEGORY_PROMOTIONS: ["promotions", "promotional", "marketing"],
        CATEGORY_UPDATES: ["updates", "updates tab", "notifications tab"],
        CATEGORY_FORUMS: ["forums", "forums tab", "mailing list"],
      },
    },
    {
      path: "extra.threadId",
      type: "string",
      description:
        "Gmail's identifier for the conversation this message belongs to. Every message in a back-and-forth carries the same value, so it is what identifies a thread — a reply cannot be recognised as a reply to anything without it. Opaque: never shown to a person and never parsed for meaning. Attachment documents carry no thread id, so a condition about a conversation matches the messages and not their attachments.",
    },
    {
      path: "extra.direction",
      type: "string",
      description:
        "Whether the account owner sent the message (the SENT label, or the owner's own address in From) or received it. A message in a thread the owner has replied to shows that reply as its own sent document in the same threadId.",
      allowedValues: ["sent", "received"],
      valueAliases: {
        sent: ["outbound", "I sent", "from me", "replied"],
        received: ["inbound", "incoming", "from them"],
      },
    },
    {
      path: "extra.unread",
      type: "boolean",
      description:
        "Whether the message is still unread in Gmail (the UNREAD label). Refreshed when the label changes.",
    },
    {
      path: "extra.archived",
      type: "boolean",
      description:
        "Whether the message has left the inbox without being sent or drafted by the owner (no INBOX, SENT or DRAFT label). Refreshed when the label changes.",
    },
    {
      path: "extra.starred",
      type: "boolean",
      description: "Whether the message is starred in Gmail. Refreshed when the label changes.",
    },
    {
      path: "extra.messageId",
      type: "string",
      description:
        "The RFC 5322 Message-ID header, angle brackets included. Opaque: a connector sends it as the In-Reply-To of a reply. Absent when the message has none.",
    },
    {
      path: "extra.inReplyTo",
      type: "string",
      description:
        "The RFC 5322 In-Reply-To header, angle brackets included: the Message-ID of the message this one answers. Absent when the message is not a reply.",
    },
    {
      path: "extra.references",
      type: "string-array",
      description:
        "The RFC 5322 References header as Message-IDs, oldest first. A connector extends it with the message being answered when it replies. Absent when the message has none.",
    },
    {
      path: "bulkMail",
      type: "boolean",
      description:
        "True when the message carried a List-Unsubscribe header — newsletters, marketing, mailing lists and anything else mass-distributed. Absent, never false, on the rest.",
    },
    {
      path: "automatedSender",
      type: "boolean",
      description:
        "True when the message came from a machine that expects no reply — a no-reply or notifications sender address, or an Auto-Submitted header. Distinct from bulk mail: this is transactional notification traffic. Absent, never false, on the rest.",
    },
  ],
};

export const googleCalendarDocumentEventProfile: DocumentEventProfile = {
  documentTypes: ["event"],
  // The organizer is recorded as the event's author, invitees as attendees,
  // and email addresses or phone numbers in the description as mentions.
  personRoles: ["author", "attendee", "mentioned"],
  metadataFields: [
    {
      path: "extra.status",
      type: "string",
      description:
        "The event's lifecycle state. A cancelled event is deleted from the index when Google reports it, rather than kept as a document, so only these two states reach a document; a cancellation is seen as the document disappearing.",
      allowedValues: ["confirmed", "tentative"],
      valueAliases: {
        tentative: ["provisional", "not yet confirmed", "penciled in"],
      },
    },
    {
      path: "extra.iCalUID",
      type: "string",
      description:
        "RFC 5545 identifier for the event — the same value every system that exposes it uses, including ICS invitations delivered by email. Stable across edits: moving an event changes its time, not this. It is what a condition about one particular event has to be written against, since a title can be shared and a time is the thing being watched for. Opaque: never shown to a person and never parsed for meaning.",
    },
    {
      path: "extra.eventId",
      type: "string",
      description:
        "Google's own event id, the one a Calendar API write names (events.patch, events.delete). It is the tail of the document's external id, which also carries the calendar id. For one occurrence of a series it is the occurrence's own id. Opaque: never shown to a person and never parsed for meaning.",
    },
    {
      path: "extra.recurringEventId",
      type: "string",
      description:
        "The eventId of the series master this occurrence belongs to. Absent on a single event and on the master itself. Opaque.",
    },
    {
      path: "extra.etag",
      type: "string",
      description:
        "Google's ETag of the event as last synced, quotes included. A connector sends it as If-Match so a write fails instead of overwriting a newer edit. Changes on every edit. Opaque.",
    },
    {
      path: "extra.sequence",
      type: "number",
      description:
        "Google's revision counter of the event, raised when the organizer changes it in a way that matters to invitees. Absent when Google reports none.",
    },
    {
      path: "extra.selfResponseStatus",
      type: "string",
      description:
        "The account owner's own RSVP: needsAction is an invitation not yet answered. Absent when the owner is not on the guest list, as on an event they organize alone.",
      allowedValues: ["needsAction", "declined", "tentative", "accepted"],
      valueAliases: {
        needsAction: ["unanswered", "no response", "not responded", "pending"],
        declined: ["said no", "turned down"],
        tentative: ["maybe", "might attend"],
        accepted: ["said yes", "going", "attending"],
      },
    },
    {
      path: "extra.organizerIsSelf",
      type: "boolean",
      description:
        "True when the account owner organizes the event, false when someone else does. Absent when the event reports no organizer.",
    },
    {
      path: "extra.transparency",
      type: "string",
      description:
        "Whether the event blocks the owner's time: opaque is busy, transparent is free. Google omits it for the default, which is reported as opaque.",
      allowedValues: ["opaque", "transparent"],
      valueAliases: {
        opaque: ["busy", "blocks time"],
        transparent: ["free", "available", "does not block time"],
      },
    },
    {
      path: "extra.visibility",
      type: "string",
      description:
        "Who else can see the event's details on a shared calendar. Google omits it for the default, which is reported as default.",
      allowedValues: ["default", "public", "private", "confidential"],
    },
    {
      path: "extra.calendarName",
      type: "string",
      // A primary calendar is named after its owner's address, and a calendar
      // shared by someone else is usually named after them, so filtering on
      // this names a human as surely as an attendee filter does.
      identifiesPeople: true,
      description:
        "Display name of the calendar the event lives on, as its owner named it — the way to distinguish a work calendar from a personal or shared one. Absent when the calendar has no name.",
    },
    {
      path: "extra.location",
      type: "string",
      description:
        "Location text exactly as entered on the event: a room, a street address, or a meeting link. Absent when the event has none.",
    },
  ],
};

/**
 * Google Drive: one `file` document per processable file. The people are the
 * owner, anyone with edit access (author), anyone with read or comment access
 * (recipient), and addresses found in the extracted text (mentioned).
 *
 * Deliberately undeclared: `extra.mimeType`, `extra.shared`, `extra.fileSize`,
 * `extra.pages` and `extra.truncated`.
 */
export const googleDriveDocumentEventProfile: DocumentEventProfile = {
  documentTypes: ["file"],
  personRoles: ["owner", "author", "recipient", "mentioned"],
  metadataFields: [
    {
      path: "extra.fileId",
      type: "string",
      description:
        "Drive's id for the file, the identifier a write-only connector names to act on it. Opaque: never shown to a person and never parsed for meaning.",
    },
    {
      path: "extra.parents",
      type: "string-array",
      description:
        "Ids of the folders the file sits in. Opaque Drive ids, not names or paths. Absent for a file with no parent folder visible to the account.",
    },
    {
      path: "extra.driveId",
      type: "string",
      description:
        "Id of the shared drive the file belongs to. Absent for a file in someone's My Drive. Opaque.",
    },
    {
      path: "extra.headRevisionId",
      type: "string",
      description:
        "Id of the file's current head revision, which changes whenever the content does. Absent for Google Docs, Sheets and Slides, which keep no binary revision. Opaque.",
    },
    {
      path: "extra.version",
      type: "string",
      description:
        "Drive's monotonically increasing version number for the file, as a decimal string. It also counts changes to the file's metadata.",
    },
    {
      path: "extra.ownedByMe",
      type: "boolean",
      description:
        "Whether the account owner owns the file, as opposed to it being shared with them.",
    },
    {
      path: "extra.canEdit",
      type: "boolean",
      description: "Whether the account owner may edit the file's content.",
    },
    {
      path: "extra.starred",
      type: "boolean",
      description: "Whether the account owner starred the file in Drive.",
    },
    {
      path: "extra.lastModifyingUserIsMe",
      type: "boolean",
      description:
        "True when the account owner made the file's most recent modification, false when someone else did. Absent when Drive did not report who modified it.",
    },
  ],
};

/**
 * Google Contacts: one `contact` document per contact, naming the contact as
 * the one `contact` person.
 *
 * Deliberately undeclared: the rendered extras (`organization`, `jobTitle`,
 * `department`, `birthday`, `addresses`, `urls`, `events`, `biography`,
 * `nickname`).
 */
export const googleContactsDocumentEventProfile: DocumentEventProfile = {
  documentTypes: ["contact"],
  personRoles: ["contact"],
  metadataFields: [
    {
      path: "extra.resourceName",
      type: "string",
      description:
        "The People API resource name of the contact, spelled people/ followed by an id. It is the identifier an update or delete of the contact names. Opaque.",
    },
    {
      path: "extra.etag",
      type: "string",
      description:
        "The contact's version tag from the People API, which an update must echo to be accepted and which changes on every edit. Opaque.",
    },
    {
      path: "extra.starred",
      type: "boolean",
      description: "Whether the contact is starred, that is a member of Google's starred group.",
    },
    {
      path: "extra.groupResourceNames",
      type: "string-array",
      description:
        "Resource names of the contact groups the contact belongs to, such as contactGroups/myContacts or contactGroups/starred, or contactGroups/ followed by an id for a user-created label. Absent when the contact is in none.",
    },
  ],
};
