// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { z } from "zod";

export const tsSchema = z.string().regex(/^\d{1,12}\.\d{6}$/);
export const idSchema = z.string().regex(/^[A-Z][A-Z0-9]{2,40}$/);
export const userSchema = z.object({
  id: idSchema,
  name: z.string().optional(),
  is_bot: z.boolean().optional(),
  profile: z
    .object({
      display_name: z.string().optional(),
      real_name: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
});
export const conversationSchema = z.object({
  id: idSchema,
  name: z.string().optional(),
  is_archived: z.boolean().optional(),
  is_member: z.boolean().optional(),
  is_im: z.boolean().optional(),
  is_mpim: z.boolean().optional(),
  is_private: z.boolean().optional(),
  user: z.string().optional(),
  last_read: tsSchema.optional(),
});
export const messageSchema = z.object({
  ts: tsSchema,
  text: z.string().default(""),
  user: idSchema.optional(),
  subtype: z.string().optional(),
  thread_ts: tsSchema.optional(),
  latest_reply: tsSchema.optional(),
  reply_count: z.number().int().optional(),
  edited: z.object({ ts: tsSchema }).optional(),
  files: z
    .array(z.object({ name: z.string().optional(), permalink: z.string().url().optional() }))
    .optional(),
});
export type SlackUser = z.infer<typeof userSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type Message = z.infer<typeof messageSchema>;
export interface Identity {
  team_id: string;
  user_id: string;
  team: string;
  url: string;
}
export interface Credential {
  token: string;
  cookie?: string;
  userAgent?: string;
  identity: Identity;
}
export const DAY = 86_400_000;
/** Never pass floating point seconds to Slack: even seven decimals can return an empty page. */
export function slackTs(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error("Invalid Slack timestamp");
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}000`;
}
export function tsMs(ts: string): number {
  return Number(tsSchema.parse(ts)) * 1000;
}
export function accountKey(identity: Pick<Identity, "team_id" | "user_id">): string {
  return `${idSchema.parse(identity.team_id)}-${idSchema.parse(identity.user_id)}`;
}
export function conversationKind(c: Conversation): string {
  return c.is_im ? "dm" : c.is_mpim ? "group-dm" : c.is_private ? "private-channel" : "channel";
}
export function workspaceUrl(value: string): string {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    !/^[a-z0-9-]+(\.enterprise)?\.slack\.com$/.test(u.hostname) ||
    u.port ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/"
  )
    throw new Error("Invalid Slack workspace URL");
  return u.origin + "/";
}
export function permalink(
  identity: Identity,
  channel: string,
  ts: string,
  threadTs?: string,
): string {
  const id = idSchema.parse(channel);
  const base = `${workspaceUrl(identity.url)}archives/${id}/p${tsSchema.parse(ts).replace(".", "")}`;
  return threadTs && threadTs !== ts
    ? `${base}?thread_ts=${tsSchema.parse(threadTs)}&cid=${id}`
    : base;
}
