// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the two Notion sources' documents can be asked about — the document
 * half of the contract `AnalyticsTableSchema` already covers for rows.
 *
 * Every entry mirrors what the normalizer actually writes. All three document
 * shapes (a standalone page, a database's schema summary, a database row)
 * stamp the `document` type, name `created_by` as `author`, and name a
 * distinct `last_edited_by` as `mentioned`; only the summary document carries
 * a tag. `extra.notionId` and the derived analytics table name
 * (`extra.duckdbTable`) stay undeclared: no natural-language phrase yields
 * one of those values. The parent, data source and user ids that are declared
 * are opaque too, but a write-only connector names them to act on a page, so
 * they are declared for the code that reads them rather than for a phrase.
 */

import type { DocumentEventProfile } from "@omnesis/source-sdk";

/**
 * Standalone workspace pages. Pages parented by a database are excluded here —
 * the databases source owns those.
 */
export const notionPagesDocumentProfile: DocumentEventProfile = {
  documentTypes: ["document"],
  personRoles: ["author", "mentioned"],
  metadataFields: [
    {
      path: "extra.parentType",
      type: "string",
      description:
        "Where the page sits in the workspace hierarchy: at the workspace root, nested under another page, or nested inside a block such as a toggle or a column. Notion's own parent vocabulary, so other values can appear as the API grows.",
      canonicalValues: ["workspace", "page_id", "block_id"],
      valueAliases: {
        workspace: ["top-level page", "workspace root", "not a subpage"],
        page_id: ["subpage", "child page", "nested under another page"],
        block_id: ["inside a block", "inside a toggle", "inside a column"],
      },
    },
    {
      path: "extra.parentId",
      type: "string",
      description:
        "Id of the object's immediate parent: the page, database, data source or block it sits under. Absent for a page at the workspace root. Opaque; `extra.parentType` says which kind it is.",
    },
    {
      path: "extra.lastEditedTime",
      type: "string",
      description:
        "When the object was last edited, as an ISO 8601 instant, as Notion reports it. Refreshed on every edit.",
    },
    {
      path: "extra.archived",
      type: "boolean",
      description: "Whether the object is archived in Notion.",
    },
    {
      path: "extra.inTrash",
      type: "boolean",
      description: "Whether the object is in Notion's trash.",
    },
    {
      path: "extra.createdByUserId",
      type: "string",
      description: "Notion user id of whoever created the object. Opaque.",
    },
    {
      path: "extra.lastEditedByUserId",
      type: "string",
      description: "Notion user id of whoever last edited the object. Opaque.",
    },
    {
      path: "extra.createdBySelf",
      type: "boolean",
      description:
        "True when the owner of the Notion connection created the object, false when someone else did. Absent when Notion does not name the connection's owner.",
    },
    {
      path: "extra.lastEditedBySelf",
      type: "boolean",
      description:
        "True when the owner of the Notion connection made the last edit, false when someone else did. Absent when Notion does not name the connection's owner.",
    },
  ],
};

/**
 * Notion databases: one document summarising each database's schema, plus one
 * document per row.
 */
export const notionDatabasesDocumentProfile: DocumentEventProfile = {
  documentTypes: ["document"],
  personRoles: ["author", "mentioned"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description:
        "Carried only by the document that summarises a database's schema, which is how a database itself is told apart from its rows — row documents carry no tags.",
      allowedValues: ["notion-database"],
      valueAliases: {
        "notion-database": ["a database", "a database's schema", "a table definition"],
      },
    },
    {
      path: "extra.notionDatabaseId",
      type: "string",
      description:
        "Id of the database a row belongs to, whether Notion parents the row by database or by data source. Carried by row documents only. Opaque.",
    },
    {
      path: "extra.dataSourceId",
      type: "string",
      description:
        "Id of the data source a row belongs to, the identifier a query or a new row names. Carried by row documents only. Opaque.",
    },
    {
      path: "extra.parentId",
      type: "string",
      description:
        "Id of the object's immediate parent: the page, database, data source or block it sits under. Absent for a page at the workspace root. Opaque; `extra.parentType` says which kind it is.",
    },
    {
      path: "extra.lastEditedTime",
      type: "string",
      description:
        "When the object was last edited, as an ISO 8601 instant, as Notion reports it. Refreshed on every edit.",
    },
    {
      path: "extra.archived",
      type: "boolean",
      description: "Whether the object is archived in Notion.",
    },
    {
      path: "extra.inTrash",
      type: "boolean",
      description: "Whether the object is in Notion's trash.",
    },
    {
      path: "extra.createdByUserId",
      type: "string",
      description: "Notion user id of whoever created the object. Opaque.",
    },
    {
      path: "extra.lastEditedByUserId",
      type: "string",
      description: "Notion user id of whoever last edited the object. Opaque.",
    },
    {
      path: "extra.createdBySelf",
      type: "boolean",
      description:
        "True when the owner of the Notion connection created the object, false when someone else did. Absent when Notion does not name the connection's owner.",
    },
    {
      path: "extra.lastEditedBySelf",
      type: "boolean",
      description:
        "True when the owner of the Notion connection made the last edit, false when someone else did. Absent when Notion does not name the connection's owner.",
    },
  ],
};
