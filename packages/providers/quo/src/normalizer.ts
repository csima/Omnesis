// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash, countryNameToISO2, normalizePhone } from "@omnesis/core";
import type { DocumentInput, PersonMention, ProviderId, SourceId } from "@omnesis/types";
import type { QuoMessage } from "./schemas.js";

/** Longest message text kept in a document; Quo sends at most 1,600 characters. */
const MAX_TEXT_CHARS = 20_000;

/** One of the organization's own Quo numbers. */
export interface QuoLine {
  id: string;
  /** E.164. */
  number: string;
  name?: string;
}

export interface NormalizeContext {
  providerId: ProviderId;
  sourceId: SourceId;
  /** The organization id (`OR…`), which is the account id. */
  organizationId: string;
  /** The organization's numbers by Quo phone-number id. */
  lines: ReadonlyMap<string, QuoLine>;
  /** ISO 3166-1 region used when a number is not already international. */
  phoneRegion?: string;
}

/** The self LID: the account's own organization, paired through `selfIdentity`. */
export function quoLid(organizationId: string): string {
  return `quo:${organizationId}`;
}

/**
 * Where a message opens in Quo's web app: its conversation in the number's
 * inbox, scrolled to the message. The shape is the one Quo itself puts in a
 * webhook's `links.quo`; a message with no number has no inbox to open in.
 */
export function quoMessageUrl(message: QuoMessage): string | undefined {
  if (!message.phoneNumberId) return undefined;
  return (
    `https://my.quo.com/inbox/${encodeURIComponent(message.phoneNumberId)}` +
    `/c/${encodeURIComponent(message.conversationId)}?at=${encodeURIComponent(message.id)}`
  );
}

/** `urlPatterns` entry: group 1 is the message id, which is the external id. */
export const QUO_MESSAGE_URL_PATTERN =
  "my\\.quo\\.com/inbox/PN[A-Za-z0-9]+/c/CN[A-Za-z0-9]+\\?(?:[^#\\s]*&)?at=(AC[A-Za-z0-9]+)";

const E164 = /^\+[1-9]\d{6,14}$/;
const SHORT_CODE = /^\d{3,8}$/;
const WITHHELD = /^(anonymous|blocked|restricted)$/i;

/** What a `from` or `to` value is: a dialable number, or something that names nobody. */
type Party =
  | { kind: "phone"; value: string }
  | { kind: "short-code"; value: string }
  | { kind: "withheld"; value: string }
  | { kind: "sender-id"; value: string };

function classify(raw: string, region?: string): Party {
  const value = raw.trim();
  if (E164.test(value)) {
    // Quo already writes numbers in E.164. A number the phone library does
    // not recognise yet (a newly opened range, a reserved test range) is
    // still the canonical form, so it is kept rather than losing the person.
    return { kind: "phone", value: normalizePhone(value, countryNameToISO2(region)) ?? value };
  }
  if (SHORT_CODE.test(value)) return { kind: "short-code", value };
  if (WITHHELD.test(value)) return { kind: "withheld", value };
  return { kind: "sender-id", value };
}

/**
 * One Quo text message as one document.
 *
 * An outgoing message was sent from one of the organization's own numbers,
 * which is the account owner's side of the conversation; its sender is the
 * self LID (`quo:<organization>`), which the gateway resolves to the self
 * person through the descriptor's `selfIdentity`, together with the Quo
 * number it went out on. An incoming message names that same self as a
 * recipient. Everyone else is a phone number; short codes, alphanumeric
 * sender ids and withheld callers name nobody and become no person.
 */
export function normalizeMessage(message: QuoMessage, ctx: NormalizeContext): DocumentInput {
  const outgoing = message.direction === "outgoing";
  const ownNumbers = new Set(
    [...ctx.lines.values()].map((l) => classifyPhone(l.number, ctx.phoneRegion) ?? l.number),
  );
  const line = ctx.lines.get(message.phoneNumberId ?? "");
  const lineNumber =
    (line ? (classifyPhone(line.number, ctx.phoneRegion) ?? line.number) : undefined) ??
    (outgoing
      ? classifyPhone(message.from, ctx.phoneRegion)
      : message.to
          .map((t) => classifyPhone(t, ctx.phoneRegion))
          .find((n) => n && ownNumbers.has(n)));
  if (lineNumber) ownNumbers.add(lineNumber);

  const sender = classify(message.from, ctx.phoneRegion);
  const recipients = message.to.map((t) => classify(t, ctx.phoneRegion));
  const isOwn = (p: Party) => p.kind === "phone" && ownNumbers.has(p.value);
  const counterparts = dedupe(
    [...(outgoing ? [] : [sender]), ...recipients].filter((p) => !isOwn(p)),
  );

  const self: PersonMention = {
    role: outgoing ? "sender" : "recipient",
    identifiers: [
      { kind: "lid", value: quoLid(ctx.organizationId) },
      ...(lineNumber ? [{ kind: "phone" as const, value: lineNumber }] : []),
    ],
  };
  const people: PersonMention[] = [self];
  for (const party of counterparts) {
    if (party.kind !== "phone") continue;
    const role = !outgoing && party.value === sender.value ? "sender" : "recipient";
    people.push({ role, identifiers: [{ kind: "phone", value: party.value }] });
  }

  const isGroup = counterparts.length > 1;
  const names = counterparts.map((p) => p.value);
  const title = outgoing
    ? `${isGroup ? "Group text" : "Text"} to ${listLabel(names)}`
    : `${isGroup ? "Group text" : "Text"} from ${sender.kind === "withheld" ? "a withheld number" : sender.value}`;

  const lineLabel = lineNumber ? `${lineNumber}${line?.name ? ` (${line.name})` : ""}` : undefined;
  const text =
    message.text.length > MAX_TEXT_CHARS
      ? `${message.text.slice(0, MAX_TEXT_CHARS)}…`
      : message.text;
  const media = message.media;
  const lines = [
    text.trim() ? text : "_(no text)_",
    ...(media.length
      ? [
          `_${media.length} attachment${media.length === 1 ? "" : "s"}${
            media.some((m) => m.type)
              ? ` (${[...new Set(media.map((m) => m.type ?? "unknown type"))].join(", ")})`
              : ""
          }_`,
        ]
      : []),
    "",
    "---",
    outgoing
      ? `Outgoing text, sent from the Quo number ${lineLabel ?? message.from}`
      : `Incoming text, received on the Quo number ${lineLabel ?? "of this workspace"}`,
    `From: ${message.from}`,
    `To: ${message.to.join(", ")}`,
  ];
  const content = lines.join("\n");

  const automated = !outgoing && (sender.kind === "short-code" || sender.kind === "sender-id");
  const sourceUrl = quoMessageUrl(message);
  const createdAt = new Date(message.createdAt).toISOString();
  const updatedAt = message.updatedAt ? new Date(message.updatedAt).toISOString() : createdAt;

  return {
    providerId: ctx.providerId,
    sourceId: ctx.sourceId,
    externalId: message.id,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "conversation",
      ...(sourceUrl ? { sourceUrl } : {}),
      people,
      ...(automated ? { automatedSender: true } : {}),
      extra: {
        direction: message.direction,
        threadId: message.conversationId,
        isGroup,
        deliveryStatus: message.status,
        counterparts: names,
        ...(lineNumber ? { quoNumber: lineNumber } : {}),
        ...(line?.name ? { quoNumberName: line.name } : {}),
      },
    },
    sourceCreatedAt: createdAt,
    sourceUpdatedAt: updatedAt < createdAt ? createdAt : updatedAt,
  };
}

function classifyPhone(raw: string, region?: string): string | undefined {
  const party = classify(raw, region);
  return party.kind === "phone" ? party.value : undefined;
}

function dedupe(parties: Party[]): Party[] {
  const seen = new Set<string>();
  return parties.filter((p) => {
    const key = `${p.kind}:${p.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listLabel(values: string[]): string {
  if (values.length === 0) return "nobody";
  if (values.length <= 3) return values.join(", ");
  return `${values.slice(0, 3).join(", ")} and ${values.length - 3} more`;
}
