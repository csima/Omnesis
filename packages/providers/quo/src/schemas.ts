// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The shapes this package reads from the Quo API, version `2026-03-30`, as
 * zod schemas. Everything Quo returns crosses into the package through these:
 * a list envelope that does not parse fails the request, while one message
 * that does not parse is dropped on its own, so a single odd record never
 * stops the rest of the page.
 *
 * Unknown fields are ignored, as Quo's versioning page asks: new response
 * fields ship without a new version. Enumerations this package does not act
 * on (`status`) are read as plain strings for the same reason.
 *
 * https://www.quo.com/docs/2026-03-30/messages/list-messages
 * https://www.quo.com/docs/2026-03-30/phone-numbers/list-phone-numbers
 */

import { z } from "zod";

const isoInstant = z.string().refine((v) => Number.isFinite(Date.parse(v)), "not a timestamp");

export const quoMessageSchema = z.object({
  id: z.string().regex(/^AC[A-Za-z0-9]+$/),
  from: z.string(),
  to: z.array(z.string()),
  text: z.string(),
  phoneNumberId: z.string().nullish(),
  conversationId: z.string().min(1),
  direction: z.enum(["incoming", "outgoing"]),
  userId: z.string().nullish(),
  status: z.string().min(1),
  createdAt: isoInstant,
  updatedAt: isoInstant.nullish(),
  media: z
    .array(z.object({ url: z.string(), type: z.string().nullish() }))
    .nullish()
    .transform((m) => m ?? []),
});
export type QuoMessage = z.infer<typeof quoMessageSchema>;

export const quoPhoneNumberSchema = z.object({
  id: z.string().min(1),
  phoneNumber: z.string().min(1),
  name: z.string().nullish(),
});
export type QuoPhoneNumber = z.infer<typeof quoPhoneNumberSchema>;

export const quoOrganizationSchema = z.object({
  data: z.object({
    id: z.string().regex(/^OR[A-Za-z0-9]+$/),
    name: z.string().nullish(),
  }),
});
export type QuoOrganization = z.infer<typeof quoOrganizationSchema>["data"];

/** Every list endpoint answers `{ data: [...], nextCursor }`. Items are parsed one by one. */
export const quoListEnvelopeSchema = z.object({
  data: z.array(z.unknown()),
  nextCursor: z.string().min(1).nullish(),
});
