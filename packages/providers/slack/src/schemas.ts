// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import type { AnalyticsTableSchema, ColumnDefinition, ColumnType } from "@omnesis/source-sdk";
const col = (
  name: string,
  type: ColumnType,
  description: string,
  nullable = false,
): ColumnDefinition => ({ name, type, description, nullable });
const owner = col(
  "source_account_id",
  "VARCHAR",
  "Workspace/user account; each mode has distinct tables",
);
const channel = col("conversation_id", "VARCHAR", "Slack conversation ID");
const base = {
  sharedDiscriminatorColumn: "source_account_id",
  semanticTimeColumn: null,
  record: { titleColumns: ["conversation_id"], keyColumns: ["conversation_id"] },
};
export const messagesSchema: AnalyticsTableSchema = {
  ...base,
  tableName: "slack_messages",
  displayName: "Slack messages",
  description: "Indexed messages and replies; never credentials",
  columns: [
    owner,
    channel,
    col("day", "VARCHAR", "UTC day of the thread root"),
    col("ts", "VARCHAR", "Message Slack timestamp, six decimals"),
    col("thread_ts", "VARCHAR", "Thread root, or message timestamp"),
    col("user_id", "VARCHAR", "Author user ID", true),
    col("text", "VARCHAR", "Slack message text"),
    col("raw", "JSON", "Minimal normalized Slack message fields"),
    col("posted_at", "TIMESTAMPTZ", "Message timestamp"),
    col("source_url", "VARCHAR", "Message permalink"),
    col("self_id", "VARCHAR", "Account user ID"),
  ],
  primaryKey: ["source_account_id", "conversation_id", "day", "ts"],
  deleteKey: ["source_account_id", "conversation_id", "day"],
  semanticTimeColumn: "posted_at",
  record: { titleColumns: ["text"], keyColumns: ["conversation_id", "ts"] },
};
export const daysSchema: AnalyticsTableSchema = {
  ...base,
  tableName: "slack_days",
  displayName: "Slack conversation days",
  description: "Bounded reconciliation signatures for daily conversation documents",
  columns: [
    owner,
    channel,
    col("day", "VARCHAR", "UTC document day"),
    col("hash", "VARCHAR", "Last rendered content hash"),
  ],
  primaryKey: ["source_account_id", "conversation_id", "day"],
};
export const positionsSchema: AnalyticsTableSchema = {
  ...base,
  tableName: "slack_read_positions",
  displayName: "Slack read positions",
  description: "Successfully observed conversation markers only; thread markers override last_read",
  columns: [
    owner,
    channel,
    col("workspace_id", "VARCHAR", "Workspace ID"),
    col("kind", "VARCHAR", "dm, group-dm, channel or private-channel"),
    col("last_read", "VARCHAR", "Read-through Slack timestamp"),
    col("thread_reads", "JSON", "Object mapping root timestamp to read-through timestamp"),
    col("observed_at", "TIMESTAMPTZ", "When Slack provided this marker"),
  ],
  primaryKey: ["source_account_id", "conversation_id"],
};
export const groupsSchema: AnalyticsTableSchema = {
  tableName: "slack_usergroups",
  displayName: "Slack user groups",
  description:
    "User groups the account belongs to; membership fetched with usergroups.list include_users",
  columns: [owner, col("group_id", "VARCHAR", "Slack user-group ID")],
  primaryKey: ["source_account_id", "group_id"],
  deleteKey: ["source_account_id"],
  sharedDiscriminatorColumn: "source_account_id",
  semanticTimeColumn: null,
  record: { titleColumns: ["group_id"], keyColumns: ["group_id"] },
};
export const slackSchemas = [messagesSchema, daysSchema, positionsSchema, groupsSchema];

export function schemasFor(session: boolean): AnalyticsTableSchema[] {
  return slackSchemas.map((s) => ({
    ...s,
    tableName: session ? s.tableName.replace("slack_", "slack_session_") : s.tableName,
  }));
}
