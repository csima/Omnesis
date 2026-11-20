// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Mac's own Contacts as a handle → name directory, for sources that only
 * see raw handles (iMessage's `handle.id`: an E.164 phone or an email).
 *
 * Phones are keyed exactly as the Contacts source normalizes them
 * (`normalizeContactPhone`: per-number country, then the card's first postal
 * address, then the collector's phone region) and emails as it does
 * (`normalizeEmail`). A number libphonenumber rejects — a short code, a range
 * its metadata does not know — is keyed by its digits instead, so it still
 * matches a handle written the same way.
 *
 * A handle two cards give different names is ambiguous, and has no name: a
 * guess between them would put the wrong name on a conversation.
 */

import {
  countryNameToISO2,
  createLogger,
  looksLikePhone,
  normalizeEmail,
  normalizePhone,
  toErrorMessage,
} from "@omnesis/core";
import { addressBookSignature, contactDisplayName, normalizeContactPhone } from "./contacts.js";
import type { ContactNameFields } from "./contacts.js";
import type { ContactsStore } from "./db-helpers/contacts-db.js";
import type { Db } from "./db-helpers/internal.js";

const log = createLogger("provider:apple:contact-names");

/** What the address books say about one handle. */
export type HandleNameLookup =
  { kind: "unique"; name: string } | { kind: "ambiguous"; names: string[] } | { kind: "unknown" };

const UNKNOWN: HandleNameLookup = { kind: "unknown" };

/** The directory key of a phone: its E.164 form, else its bare digits. */
function phoneKey(normalized: string | null, raw: string): string | null {
  if (normalized) return `phone:${normalized}`;
  const digits = raw.trim().replace(/[^\d+]/g, "");
  return /\d/.test(digits) ? `digits:${digits}` : null;
}

function emailKey(raw: string): string | null {
  const email = normalizeEmail(raw);
  return email.includes("@") ? `email:${email}` : null;
}

/** A name worth showing beside a handle: not empty, not itself a handle. */
function usableName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed || looksLikePhone(trimmed) || trimmed.includes("@")) return undefined;
  return trimmed;
}

/** Handle → name, built from every readable address book. */
export class HandleNameIndex {
  static readonly empty = new HandleNameIndex(new Map());

  /** Lookups memoised by raw handle: a snapshot asks once per message row. */
  private readonly memo = new Map<string, HandleNameLookup>();

  constructor(
    /** Directory key → every distinct name the address books give it. */
    private readonly names: ReadonlyMap<string, ReadonlySet<string>>,
    private readonly phoneRegion?: string,
  ) {}

  /** Number of distinct keys (phones and emails) with at least one name. */
  get size(): number {
    return this.names.size;
  }

  /** Number of keys two or more cards give different names. */
  get ambiguousCount(): number {
    let count = 0;
    for (const set of this.names.values()) if (set.size > 1) count++;
    return count;
  }

  /** What the address books say about a raw chat.db handle. */
  lookup(handle: string): HandleNameLookup {
    if (this.names.size === 0 || !handle) return UNKNOWN;
    const memoised = this.memo.get(handle);
    if (memoised) return memoised;
    const key = handle.includes("@")
      ? emailKey(handle)
      : phoneKey(normalizePhone(handle, this.regionHints()), handle);
    const set = key ? this.names.get(key) : undefined;
    const result: HandleNameLookup = !set
      ? UNKNOWN
      : set.size === 1
        ? { kind: "unique", name: [...set][0] }
        : { kind: "ambiguous", names: [...set].sort() };
    this.memo.set(handle, result);
    return result;
  }

  /** The one name for a handle; `undefined` when it has none or several. */
  nameFor(handle: string | null | undefined): string | undefined {
    if (!handle) return undefined;
    const result = this.lookup(handle);
    return result.kind === "unique" ? result.name : undefined;
  }

  private regionHints() {
    const region = countryNameToISO2(this.phoneRegion);
    return region ? [region] : undefined;
  }
}

/**
 * Read every phone and email of every person card in these address books.
 * Throws when a book cannot be read; the caller decides what that means.
 */
export function buildHandleNameIndex(dbs: readonly Db[], phoneRegion?: string): HandleNameIndex {
  const names = new Map<string, Set<string>>();
  const add = (key: string | null, name: string) => {
    if (!key) return;
    const set = names.get(key) ?? new Set<string>();
    set.add(name);
    names.set(key, set);
  };

  for (const db of dbs) {
    const cards = db
      .prepare(
        `SELECT Z_PK as pk, ZFIRSTNAME as firstName, ZMIDDLENAME as middleName,
                ZLASTNAME as lastName, ZORGANIZATION as organization, ZNICKNAME as nickname
           FROM ZABCDRECORD WHERE Z_ENT = 22`,
      )
      .all() as (ContactNameFields & { pk: number })[];
    const nameByPk = new Map<number, string>();
    for (const card of cards) {
      const name = usableName(contactDisplayName(card));
      if (name) nameByPk.set(card.pk, name);
    }
    if (nameByPk.size === 0) continue;

    const emails = db
      .prepare("SELECT ZOWNER as ownerPk, ZADDRESS as address FROM ZABCDEMAILADDRESS")
      .all() as { ownerPk: number; address: string | null }[];
    for (const { ownerPk, address } of emails) {
      const name = nameByPk.get(ownerPk);
      if (name && address) add(emailKey(address), name);
    }

    const addressCountry = firstAddressCountries(db);
    for (const { ownerPk, fullNumber, countryCode } of readPhones(db)) {
      const name = nameByPk.get(ownerPk);
      if (!name || !fullNumber) continue;
      const normalized = normalizeContactPhone(
        fullNumber,
        countryCode,
        addressCountry.get(ownerPk),
        phoneRegion,
      );
      add(phoneKey(normalized, fullNumber), name);
    }
  }
  return new HandleNameIndex(names, phoneRegion);
}

/** Phone rows, without `ZCOUNTRYCODE` on a macOS that lacks the column. */
function readPhones(
  db: Db,
): { ownerPk: number; fullNumber: string | null; countryCode: unknown }[] {
  const select = (country: string) =>
    db
      .prepare(
        `SELECT ZOWNER as ownerPk, ZFULLNUMBER as fullNumber, ${country} as countryCode
           FROM ZABCDPHONENUMBER`,
      )
      .all() as { ownerPk: number; fullNumber: string | null; countryCode: unknown }[];
  try {
    return select("ZCOUNTRYCODE");
  } catch {
    return select("NULL");
  }
}

/** Each card's first postal address country, the Contacts source's hint. */
function firstAddressCountries(db: Db): Map<number, string> {
  const countries = new Map<number, string>();
  let rows: { ownerPk: number; country: string | null }[];
  try {
    rows = db
      .prepare(
        `SELECT ZOWNER as ownerPk, ZCOUNTRYNAME as country FROM ZABCDPOSTALADDRESS
          ORDER BY ZOWNER ASC, ZORDERINGINDEX ASC`,
      )
      .all() as { ownerPk: number; country: string | null }[];
  } catch {
    return countries;
  }
  const seen = new Set<number>();
  for (const { ownerPk, country } of rows) {
    if (seen.has(ownerPk)) continue;
    seen.add(ownerPk);
    if (country) countries.set(ownerPk, country);
  }
  return countries;
}

/**
 * What the address books look like now, cheaply: each book's record signature
 * plus its phone and email row counts, or that it could not be read.
 */
function addressBooksFingerprint(stores: readonly ContactsStore[]): string {
  return stores
    .map((store) => {
      if (store.kind === "unavailable") return `${store.key}=unavailable`;
      const counts = store.db
        .prepare(
          `SELECT (SELECT COUNT(*) || ':' || COALESCE(MAX(Z_PK), 0) FROM ZABCDPHONENUMBER) as phones,
                  (SELECT COUNT(*) || ':' || COALESCE(MAX(Z_PK), 0) FROM ZABCDEMAILADDRESS) as emails`,
        )
        .get() as { phones: string; emails: string };
      return `${store.key}=${addressBookSignature(store.db)}|${counts.phones}|${counts.emails}`;
    })
    .sort()
    .join("\n");
}

/**
 * The handle → name index for a source, rebuilt only when the address books
 * change. `current()` is meant to be called once per sync pass.
 *
 * A failure never fails the sync: with nothing readable the index is empty.
 * A partial read (a book locked or refused this pass) does not replace an
 * index built from a complete one — dropping names for a pass would re-render
 * every conversation that showed them, twice.
 */
export class ContactNameDirectory {
  private index = HandleNameIndex.empty;
  private fingerprint: string | undefined;
  private haveCompleteIndex = false;
  private lastNote: string | undefined;

  constructor(
    private readonly readStores: () => ContactsStore[],
    private readonly phoneRegion?: string,
  ) {}

  current(): HandleNameIndex {
    let stores: ContactsStore[];
    let fingerprint: string;
    try {
      stores = this.readStores();
      fingerprint = addressBooksFingerprint(stores);
    } catch (err) {
      return this.degraded(`could not read the address books: ${toErrorMessage(err)}`);
    }
    if (fingerprint === this.fingerprint) return this.index;
    this.fingerprint = fingerprint;

    const open = stores.flatMap((store) => (store.kind === "open" ? [store.db] : []));
    const unreadable = stores.length - open.length;
    if (open.length === 0) {
      return this.degraded(
        stores.length === 0 ? "no address book on this Mac" : "no address book could be read",
      );
    }
    if (unreadable > 0 && this.haveCompleteIndex) {
      return this.degraded(`${unreadable} address book(s) could not be read`);
    }
    try {
      this.index = buildHandleNameIndex(open, this.phoneRegion);
    } catch (err) {
      // Read again next pass: a lock taken mid-read is gone by then.
      this.fingerprint = undefined;
      return this.degraded(`could not read the address books: ${toErrorMessage(err)}`);
    }
    this.haveCompleteIndex = unreadable === 0;
    this.lastNote = undefined;
    log.debug(
      `Contact names: ${this.index.size} handles from ${open.length} address book(s), ${this.index.ambiguousCount} ambiguous`,
    );
    return this.index;
  }

  /** Keep a complete index through a failed read; otherwise there are no names. */
  private degraded(reason: string): HandleNameIndex {
    if (!this.haveCompleteIndex) this.index = HandleNameIndex.empty;
    const note = this.haveCompleteIndex
      ? `Contact names: ${reason}; keeping the names from the last complete read`
      : `Contact names unavailable: ${reason}`;
    if (note !== this.lastNote) {
      log.debug(note);
      this.lastNote = note;
    }
    return this.index;
  }
}
