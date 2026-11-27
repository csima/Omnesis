// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The search page's source chips, as edits to the query text.
//
// A chip is not separate state: it is a `source:<type>` token in the query.
// Selecting one appends the token, deselecting removes it, and a chip reads
// as selected whenever the query holds a matching token — so a token typed by
// hand, a shared link and back navigation all light the same chips. Several
// tokens OR together, which is what the gateway's query parser already does.
//
// Nothing here knows any particular source: the chip list is whatever types
// the operator's registered sources have, labelled through the caller's
// lookup.

import { sourceTypeOf } from "./source-id.js";

// A `source:` token whose value is quoted, or runs to the next whitespace —
// the two value shapes the gateway's query parser accepts.
const SOURCE_TOKEN = /^source:(?:"([^"]+)"|(\S+))/i;

/**
 * Every `source:` token in `query`, in order, as `{ start, end, value }`.
 *
 * A token starts at the beginning of the query or after whitespace, so
 * `resource:web` is not one. Text inside a quoted phrase is never a token:
 * `"notes source:web"` searches for that phrase. A quote with no partner is
 * an ordinary character, so an unfinished phrase being typed does not hide
 * the tokens after it.
 */
export function findSourceTokens(query) {
  if (typeof query !== "string" || query.length === 0) return [];
  const tokens = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    if (ch === '"') {
      const close = query.indexOf('"', i + 1);
      if (close !== -1) {
        i = close + 1;
        continue;
      }
    } else if (i === 0 || /\s/.test(query[i - 1])) {
      const match = SOURCE_TOKEN.exec(query.slice(i));
      if (match) {
        const end = i + match[0].length;
        tokens.push({ start: i, end, value: match[1] ?? match[2] });
        i = end;
        continue;
      }
    }
    i++;
  }
  return tokens;
}

function sameType(value, type) {
  return typeof value === "string" && typeof type === "string" && value.toLowerCase() === type.toLowerCase();
}

/**
 * Whether the query holds a `source:` token naming exactly this bare type,
 * case-insensitively. A token naming one account (`source:<type>:<account>`)
 * is a narrower filter than the chip and does not light it.
 */
export function hasSourceFilter(query, type) {
  return findSourceTokens(query).some((token) => sameType(token.value, type));
}

/** The query with ` source:<type>` appended; just the token when it is blank. */
export function addSourceFilter(query, type) {
  const text = typeof query === "string" ? query.trim() : "";
  return text ? `${text} source:${type}` : `source:${type}`;
}

/**
 * The query without its `source:` tokens for this type. Every other
 * character is kept as it was; the whitespace around each removed token
 * collapses to one space, or to nothing at either end of the query.
 */
export function removeSourceFilter(query, type) {
  if (typeof query !== "string") return "";
  const matches = findSourceTokens(query).filter((token) => sameType(token.value, type));
  let out = query;
  for (const { start, end } of matches.reverse()) {
    const before = out.slice(0, start).replace(/\s+$/, "");
    const after = out.slice(end).replace(/^\s+/, "");
    out = before && after ? `${before} ${after}` : before || after;
  }
  return out;
}

/** Add the type's token when the query lacks it, else remove it. */
export function toggleSourceFilter(query, type) {
  return hasSourceFilter(query, type) ? removeSourceFilter(query, type) : addSourceFilter(query, type);
}

/**
 * The chips to offer: one per source type among the registered sources.
 *
 *   - `sources` — the registered sources (`GET /admin/sources` `items`); each
 *     needs an `id`, and its `type` when present. Accounts of one type fold
 *     into one chip. Gateway-internal sources are not registered, so they
 *     never appear.
 *   - `documentCounts` — `GET /status` `documents.bySource` (source id →
 *     document count), or null when it is unavailable. A type's count is the
 *     sum over its accounts; a type with no documents gets no chip, since
 *     filtering to it finds nothing.
 *   - `experimental` — `GET /status` `experimental`; when false, a type for
 *     which `isExperimental(type)` holds gets no chip.
 *   - `label(type)` — the type's display name.
 *
 * Ordered by document count, most first, then by label. Without counts,
 * every type is offered, by label.
 */
export function buildSourceChips({ sources, documentCounts = null, experimental = false, isExperimental = () => false, label = (type) => type }) {
  if (!Array.isArray(sources)) return [];
  const haveCounts = documentCounts != null && typeof documentCounts === "object";
  const byType = new Map();
  for (const source of sources) {
    const id = typeof source?.id === "string" ? source.id : "";
    const type = typeof source?.type === "string" && source.type ? source.type : sourceTypeOf(id);
    if (!type) continue;
    if (!experimental && isExperimental(type)) continue;
    const count = haveCounts ? Number(documentCounts[id]) || 0 : 0;
    byType.set(type, (byType.get(type) ?? 0) + count);
  }
  const chips = [];
  for (const [type, count] of byType) {
    if (haveCounts && count === 0) continue;
    chips.push({ type, label: label(type), count });
  }
  return chips.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
