// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SyncError } from "@omnesis/types";
import { canonicalPhone } from "./normalizer.js";
import type { QuoClient } from "./client.js";
import type { QuoContact } from "./schemas.js";

/** How long a number's name, or the absence of one, is reused before Quo is asked again. */
const NAME_TTL_MS = 6 * 60 * 60_000;
/** How long contact lookups stay off after Quo refuses them. */
const REFUSED_BACKOFF_MS = 60 * 60_000;
/** Numbers per contact search, small enough that one page holds every match. */
const LOOKUP_BATCH = 25;
/** Searches one sync call may spend on names, so a call always returns. */
const MAX_LOOKUPS_PER_CALL = 8;

interface Entry {
  name: string | null;
  at: number;
}

export interface ContactNamesLog {
  warn(message: string): void;
  debug(message: string): void;
}

/** A contact's display name: first and last name, or the company when it has neither. */
export function contactName(contact: QuoContact): string | undefined {
  const person = [contact.firstName, contact.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return person || contact.company?.trim() || undefined;
}

/**
 * Names for phone numbers, from the workspace's Quo contacts: the names Quo's
 * own inbox shows beside a conversation.
 *
 * Numbers are looked up in batches through the contact search and remembered,
 * the misses too, so a number is asked about at most once every few hours. A
 * number two contacts name differently is ambiguous and gets no name. A
 * workspace whose key may not read contacts gets no names, and messages are
 * indexed as before; any other failure is the sync's, so messages are never
 * indexed without the names a retry would have given them.
 */
export class QuoContactNames {
  private readonly entries = new Map<string, Entry>();
  private refusedUntil = 0;

  constructor(
    private readonly client: QuoClient,
    private readonly now: () => number,
    private readonly log: ContactNamesLog,
    private readonly phoneRegion?: string,
  ) {}

  async namesFor(
    phones: Iterable<string>,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, string>> {
    const now = this.now();
    const wanted = [...new Set(phones)];
    const stale = wanted.filter((p) => {
      const entry = this.entries.get(p);
      return !entry || now - entry.at >= NAME_TTL_MS;
    });
    if (stale.length > 0 && now >= this.refusedUntil) await this.lookUp(stale, now, signal);

    const names = new Map<string, string>();
    for (const phone of wanted) {
      const name = this.entries.get(phone)?.name;
      if (name) names.set(phone, name);
    }
    return names;
  }

  private async lookUp(phones: string[], now: number, signal?: AbortSignal): Promise<void> {
    const limit = LOOKUP_BATCH * MAX_LOOKUPS_PER_CALL;
    if (phones.length > limit) {
      this.log.debug(`Looking up ${limit} of ${phones.length} numbers in Quo contacts this call`);
    }
    for (let i = 0; i < Math.min(phones.length, limit); i += LOOKUP_BATCH) {
      const batch = phones.slice(i, i + LOOKUP_BATCH);
      let result: Awaited<ReturnType<QuoClient["searchContactsByPhone"]>>;
      try {
        result = await this.client.searchContactsByPhone(batch, signal);
      } catch (err) {
        if (!(err instanceof SyncError) || !refusesContacts(err)) throw err;
        this.refusedUntil = now + REFUSED_BACKOFF_MS;
        this.log.warn(
          `Quo would not search contacts, so texts are indexed without names: ${err.message}`,
        );
        return;
      }
      if (result.truncated) {
        this.log.debug(
          `A Quo contact search for ${batch.length} numbers matched more than one page`,
        );
      }
      const found = new Map<string, Set<string>>();
      for (const contact of result.contacts) {
        const name = contactName(contact);
        if (!name) continue;
        for (const property of contact.properties) {
          if (property.type !== "phone-number") continue;
          const phone = canonicalPhone(property.value, this.phoneRegion);
          if (!phone || !batch.includes(phone)) continue;
          const seen = found.get(phone) ?? new Set<string>();
          seen.add(name);
          found.set(phone, seen);
        }
      }
      for (const phone of batch) {
        const candidates = found.get(phone);
        const name = candidates?.size === 1 ? [...candidates][0]! : null;
        this.entries.set(phone, { name, at: now });
      }
    }
  }
}

/** A refusal that a retry would only repeat: no permission, or no contact search on this API. */
function refusesContacts(err: SyncError): boolean {
  return err.kind === "permission" || (err.kind === "unknown" && /HTTP 40[04]/.test(err.message));
}
