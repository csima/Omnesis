// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A minimal AddressBook (`AddressBook-v22.abcddb`) for tests that read contact
 * names: person records, their phones, emails and postal addresses.
 */

import Database from "better-sqlite3";

type Db = Database.Database;

const CORE_DATA_EPOCH_MS = Date.UTC(2001, 0, 1);

export function createAddressBook(path: string): Db {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ZABCDRECORD (
      Z_PK INTEGER PRIMARY KEY,
      Z_ENT INTEGER DEFAULT 22,
      ZFIRSTNAME TEXT,
      ZLASTNAME TEXT,
      ZMIDDLENAME TEXT,
      ZORGANIZATION TEXT,
      ZNICKNAME TEXT,
      ZCREATIONDATE REAL,
      ZMODIFICATIONDATE REAL,
      ZUNIQUEID TEXT
    );
    CREATE TABLE ZABCDEMAILADDRESS (
      Z_PK INTEGER PRIMARY KEY,
      ZOWNER INTEGER,
      ZADDRESS TEXT,
      ZORDERINGINDEX INTEGER DEFAULT 0
    );
    CREATE TABLE ZABCDPHONENUMBER (
      Z_PK INTEGER PRIMARY KEY,
      ZOWNER INTEGER,
      ZFULLNUMBER TEXT,
      ZCOUNTRYCODE TEXT,
      ZORDERINGINDEX INTEGER DEFAULT 0
    );
    CREATE TABLE ZABCDPOSTALADDRESS (
      Z_PK INTEGER PRIMARY KEY,
      ZOWNER INTEGER,
      ZCOUNTRYNAME TEXT,
      ZORDERINGINDEX INTEGER DEFAULT 0
    );
  `);
  return db;
}

export interface AddressBookContact {
  firstName?: string;
  lastName?: string;
  organization?: string;
  phones?: (string | { number: string; countryCode: string })[];
  emails?: string[];
  addressCountry?: string;
  /** Defaults to the contact's primary key, so each card's date differs. */
  modifiedAt?: number;
}

export function addContact(db: Db, pk: number, contact: AddressBookContact): void {
  const modified = contact.modifiedAt ?? pk;
  db.prepare(
    `INSERT INTO ZABCDRECORD (Z_PK, Z_ENT, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION,
       ZCREATIONDATE, ZMODIFICATIONDATE, ZUNIQUEID)
     VALUES (?, 22, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pk,
    contact.firstName ?? null,
    contact.lastName ?? null,
    contact.organization ?? null,
    modified,
    modified,
    `UUID-${pk}:ABPerson`,
  );
  for (const phone of contact.phones ?? []) {
    const { number, countryCode } =
      typeof phone === "string" ? { number: phone, countryCode: null } : phone;
    db.prepare(
      "INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER, ZCOUNTRYCODE) VALUES (?, ?, ?)",
    ).run(pk, number, countryCode);
  }
  for (const email of contact.emails ?? []) {
    db.prepare("INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?, ?)").run(pk, email);
  }
  if (contact.addressCountry) {
    db.prepare("INSERT INTO ZABCDPOSTALADDRESS (ZOWNER, ZCOUNTRYNAME) VALUES (?, ?)").run(
      pk,
      contact.addressCountry,
    );
  }
}

/** Rename a card the way Contacts does: new names, a later modification date. */
export function renameContact(
  db: Db,
  pk: number,
  name: { firstName?: string; lastName?: string },
): void {
  const modified = (Date.now() - CORE_DATA_EPOCH_MS) / 1000;
  db.prepare(
    "UPDATE ZABCDRECORD SET ZFIRSTNAME = ?, ZLASTNAME = ?, ZMODIFICATIONDATE = ? WHERE Z_PK = ?",
  ).run(name.firstName ?? null, name.lastName ?? null, modified, pk);
}
