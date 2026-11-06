// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { z } from "zod";
import { conversationSchema, tsSchema } from "./types.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";

const cursorSchema = z.object({
  v: z.literal(1),
  startedAt: z.number().int(),
  lastDeepAt: z.number().int().optional(),
  channels: z.record(
    z.string(),
    z.object({
      newest: tsSchema.optional(),
      through: z.string().datetime().optional(),
      complete: z.boolean().optional(),
    }),
  ),
  pending: z
    .object({
      cut: z.number().int(),
      deep: z.boolean(),
      queue: z.array(conversationSchema),
      day: z.string().datetime().optional(),
    })
    .optional(),
});
export type SlackCursor = z.infer<typeof cursorSchema>;
export const slackStateSpec: SourceStateSpec<SlackCursor> = {
  version: 1,
  decode: (value) => {
    const r = cursorSchema.safeParse(value);
    return r.success ? r.data : null;
  },
  onUnreadable: "stop",
  maxBytes: 2_000_000,
};
