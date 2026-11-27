// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash } from "@omnesis/core";
import { type AnalyticsTableSchema } from "@omnesis/source-sdk";
import {
  type ProviderId,
  type SourceId,
  type DocumentInput,
  type PersonMention,
} from "@omnesis/types";
import type {
  PageObjectResponse,
  DataSourceObjectResponse,
  PartialUserObjectResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import type { UserMap } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Extract the title from a Notion page by finding the first property
 * with type "title" and concatenating its plain_text runs.
 */
function extractPageTitle(page: PageObjectResponse): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title") {
      const text = prop.title.map((t) => t.plain_text).join("");
      if (text) return text;
    }
  }
  return "Untitled";
}

/**
 * Extract the title from a Notion database object.
 */
function extractDatabaseTitle(database: DataSourceObjectResponse): string {
  const text = database.title.map((t) => t.plain_text).join("");
  return text || "Untitled";
}

function stableDatabaseId(database: DataSourceObjectResponse): string {
  return (
    (database as unknown as { parent?: { database_id?: string } }).parent?.database_id ??
    database.id
  );
}

function parentPageId(database: DataSourceObjectResponse): string | undefined {
  const parent =
    (database as unknown as { database_parent?: { type: string; page_id?: string } })
      .database_parent ??
    (database as unknown as { parent?: { type: string; page_id?: string } }).parent;
  return parent?.type === "page_id" ? parent.page_id : undefined;
}

/**
 * Extract a display name from a partial user object.
 * Notion API returns `{ id, object: "user" }` for page-level created_by /
 * last_edited_by — no name. We fall back to the user ID.
 */
function userName(user: PartialUserObjectResponse, userMap?: UserMap): string {
  // Try the user map first (resolved from /users API)
  if (userMap) {
    const resolved = userMap.get(user.id);
    if (resolved?.name) return resolved.name;
  }
  // Fall back to inline name if the API returned a full user object
  if ("name" in user && typeof user.name === "string" && user.name) {
    return user.name;
  }
  return user.id;
}

function userEmail(user: PartialUserObjectResponse, userMap?: UserMap): string | undefined {
  return userMap?.get(user.id)?.email;
}

/**
 * Build PersonMention array from the `created_by` / `last_edited_by` partial
 * user objects on a Notion page or database. Both response shapes carry the
 * same `PartialUserObjectResponse` for these fields, so one extractor handles
 * both.
 */
function extractPeople(
  source: Pick<PageObjectResponse, "created_by" | "last_edited_by">,
  userMap?: UserMap,
): PersonMention[] {
  const people: PersonMention[] = [];

  const createdBy = source.created_by;
  const createdByEmail = userEmail(createdBy, userMap);
  people.push({
    role: "author",
    name: userName(createdBy, userMap),
    emails: createdByEmail ? [createdByEmail] : [],
    phones: [],
  });

  const editedBy = source.last_edited_by;
  if (editedBy.id !== createdBy.id) {
    const editedByEmail = userEmail(editedBy, userMap);
    people.push({
      role: "mentioned",
      name: userName(editedBy, userMap),
      emails: editedByEmail ? [editedByEmail] : [],
      phones: [],
    });
  }

  return people;
}

/**
 * The loosely-typed parent every Notion object carries. A page parented by a
 * data source (API 2025-09-03 onward) names both the data source and the
 * database that holds it, so a row keeps its database whichever shape the
 * parent takes.
 */
type NotionParent = {
  type?: string;
  page_id?: string;
  database_id?: string;
  data_source_id?: string;
  block_id?: string;
};

function parentOf(source: { parent?: unknown }): NotionParent | undefined {
  return source.parent as NotionParent | undefined;
}

/**
 * The id of the database a row lives in. A `database_id` parent names it
 * directly; a `data_source_id` parent carries it beside the data source id.
 * `fallback` is the database the caller walked to reach the row, used only
 * when the parent itself does not name one.
 */
function extractParentDatabaseId(page: PageObjectResponse, fallback?: string): string | undefined {
  const parent = parentOf(page);
  if (parent?.type === "database_id" || parent?.type === "data_source_id") {
    return parent.database_id ?? fallback;
  }
  return undefined;
}

/** The data source a row lives in, from its parent or else the one the caller walked. */
function extractParentDataSourceId(
  page: PageObjectResponse,
  fallback?: string,
): string | undefined {
  const parent = parentOf(page);
  if (parent?.type === "data_source_id") return parent.data_source_id ?? fallback;
  if (parent?.type === "database_id") return fallback;
  return undefined;
}

/** The id of the object's immediate parent, whatever kind it is; absent at the workspace root. */
function immediateParentId(source: { parent?: unknown }): string | undefined {
  const parent = parentOf(source);
  switch (parent?.type) {
    case "page_id":
      return parent.page_id;
    case "database_id":
      return parent.database_id;
    case "data_source_id":
      return parent.data_source_id;
    case "block_id":
      return parent.block_id;
    default:
      return undefined;
  }
}

/**
 * The structured facts every Notion document carries beside its
 * type-specific ones: where the object sits, when and by whom it was last
 * touched, and whether it is archived or in the trash. The `*BySelf` flags are
 * present only when the integration's owner is known.
 */
function commonExtra(
  source: Pick<PageObjectResponse, "created_by" | "last_edited_by" | "last_edited_time"> & {
    parent?: unknown;
    archived?: boolean;
    is_archived?: boolean;
    in_trash?: boolean;
  },
  selfUserId?: string,
): Record<string, unknown> {
  const parentId = immediateParentId(source);
  return {
    ...(parentId ? { parentId } : {}),
    lastEditedTime: source.last_edited_time,
    archived: Boolean(source.archived ?? source.is_archived),
    inTrash: Boolean(source.in_trash),
    createdByUserId: source.created_by.id,
    lastEditedByUserId: source.last_edited_by.id,
    ...(selfUserId
      ? {
          createdBySelf: source.created_by.id === selfUserId,
          lastEditedBySelf: source.last_edited_by.id === selfUserId,
        }
      : {}),
  };
}

/**
 * Render a property value to a human-readable string for display in
 * database row document content.
 */
function renderPropertyValue(value: string | undefined): string {
  return value ?? "";
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Convert a standalone Notion page into a DocumentInput.
 */
export function pageToDocument(
  page: PageObjectResponse,
  markdown: string,
  sourceId: SourceId,
  providerId: ProviderId,
  userMap?: UserMap,
  linkedPageIds?: string[],
  selfUserId?: string,
): DocumentInput {
  const title = extractPageTitle(page);

  const extra: Record<string, unknown> = {
    notionId: page.id,
    parentType: page.parent.type,
    ...commonExtra(page, selfUserId),
  };
  if (linkedPageIds && linkedPageIds.length > 0) {
    extra.links = linkedPageIds;
  }

  return {
    externalId: `page-${page.id.replace(/-/g, "")}`,
    title,
    content: markdown,
    contentHash: computeContentHash(markdown),
    providerId,
    sourceId,
    metadata: {
      documentType: "document",
      sourceUrl: page.url,
      people: extractPeople(page, userMap),
      extra,
    },
    sourceCreatedAt: page.created_time,
    sourceUpdatedAt: page.last_edited_time,
  };
}

/**
 * Convert a Notion database into a summary DocumentInput that makes
 * the database discoverable via search.
 */
export function databaseSummaryToDocument(
  database: DataSourceObjectResponse,
  schema: AnalyticsTableSchema,
  sourceId: SourceId,
  providerId: ProviderId,
  userMap?: UserMap,
  selfUserId?: string,
): DocumentInput {
  const title = extractDatabaseTitle(database);
  const databaseId = stableDatabaseId(database);

  // Build property table rows from the database schema definition
  const propertyRows = Object.entries(database.properties)
    .map(([name, prop]) => `| ${name} | ${prop.type} |`)
    .join("\n");

  const columnCount = Object.keys(database.properties).length;

  const content = [
    `# ${title}`,
    "",
    `Notion database with ${columnCount} properties.`,
    "",
    "| Property | Type |",
    "|---|---|",
    propertyRows,
    "",
    `**DuckDB table:** \`${schema.tableName}\``,
    "",
    `Query with: \`npm run query -- sql "SELECT * FROM ${schema.tableName} LIMIT 10"\``,
  ].join("\n");

  const extra: Record<string, unknown> = {
    notionId: databaseId,
    duckdbTable: schema.tableName,
    ...commonExtra(database, selfUserId),
  };

  // When the database lives under a Notion page, emit a reference-graph link
  // to that parent page so the link extractor wires the two together.
  // Mirror the `page-{notionIdNoDashes}` shape used by `pageToDocument`.
  const pageId = parentPageId(database);
  if (pageId) {
    extra.links = [`page-${pageId.replace(/-/g, "")}`];
  }

  return {
    externalId: `db-${databaseId.replace(/-/g, "")}`,
    title: `[Db] ${title}`,
    content,
    contentHash: computeContentHash(content),
    providerId,
    sourceId,
    metadata: {
      documentType: "document",
      sourceUrl: database.url,
      tags: ["notion-database"],
      people: extractPeople(database, userMap),
      extra,
    },
    sourceCreatedAt: database.created_time,
    sourceUpdatedAt: database.last_edited_time,
  };
}

/**
 * Convert a Notion database row (page inside a database) into a DocumentInput.
 *
 * @param page - The page object from the Notion API
 * @param propertySummary - Pre-extracted property name→value pairs for display
 * @param dbTitle - Title of the parent database, used as a prefix
 */
/**
 * The external id of a database row's document.
 *
 * Named here, beside the document that carries it, because the snapshot has to
 * name rows the walk saw but did not ingest — a reference object with no
 * properties, a row aged out of the retention window — and a second spelling of
 * this rule would be one the snapshot and the document could disagree on.
 */
export function rowExternalId(pageId: string): string {
  return `row-${pageId.replace(/-/g, "")}`;
}

export function databaseRowToDocument(
  page: PageObjectResponse,
  propertySummary: Array<{ name: string; value: string }>,
  dbTitle: string,
  sourceId: SourceId,
  providerId: ProviderId,
  userMap?: UserMap,
  /** What the caller knows beyond the row's own parent. */
  opts: { selfUserId?: string; databaseId?: string; dataSourceId?: string } = {},
): DocumentInput {
  const rowTitle = extractPageTitle(page);
  const title = `${dbTitle} > ${rowTitle}`;

  const propertyRows = propertySummary
    .map((p) => `| ${p.name} | ${renderPropertyValue(p.value)} |`)
    .join("\n");

  const content = ["| Property | Value |", "|---|---|", propertyRows].join("\n");

  return {
    externalId: rowExternalId(page.id),
    title,
    content,
    contentHash: computeContentHash(content),
    providerId,
    sourceId,
    metadata: {
      documentType: "document",
      sourceUrl: page.url,
      people: extractPeople(page, userMap),
      extra: {
        notionId: page.id,
        notionDatabaseId: extractParentDatabaseId(page, opts.databaseId),
        dataSourceId: extractParentDataSourceId(page, opts.dataSourceId),
        ...commonExtra(page, opts.selfUserId),
      },
    },
    sourceCreatedAt: page.created_time,
    sourceUpdatedAt: page.last_edited_time,
  };
}
