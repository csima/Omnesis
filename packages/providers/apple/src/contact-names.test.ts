// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { buildHandleNameIndex, ContactNameDirectory, HandleNameIndex } from "./contact-names.js";
import { addContact, createAddressBook, renameContact } from "./testing/address-book-fixture.js";
import type { ContactsStore } from "./db-helpers/contacts-db.js";

type Db = Database.Database;

describe("buildHandleNameIndex", () => {
  let tmpDir: string;
  let book: Db;
  let secondBook: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "apple-contact-names-"));
    book = createAddressBook(join(tmpDir, "a.abcddb"));
    secondBook = createAddressBook(join(tmpDir, "b.abcddb"));
  });

  afterEach(() => {
    book.close();
    secondBook.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("matches a national number through the card's own country", () => {
    addContact(book, 1, {
      firstName: "Jamie",
      lastName: "Lopez",
      phones: [{ number: "020 7555 0123", countryCode: "gb" }],
    });
    const index = buildHandleNameIndex([book], "US");
    expect(index.nameFor("+442075550123")).toBe("Jamie Lopez");
  });

  test("falls back to the first postal address, then the collector's phone region", () => {
    addContact(book, 1, {
      firstName: "Maya",
      lastName: "Reeves",
      phones: ["020 7555 0124"],
      addressCountry: "United Kingdom",
    });
    addContact(book, 2, { firstName: "David", lastName: "Lin", phones: ["020 7555 0125"] });

    expect(buildHandleNameIndex([book], "US").nameFor("+442075550124")).toBe("Maya Reeves");
    expect(buildHandleNameIndex([book], "GB").nameFor("+442075550125")).toBe("David Lin");
  });

  test("keys a number libphonenumber rejects by its digits", () => {
    addContact(book, 1, { firstName: "Maya", lastName: "Reeves", phones: ["+1 555 010 0123"] });
    const index = buildHandleNameIndex([book]);
    expect(index.nameFor("+15550100123")).toBe("Maya Reeves");
    expect(index.nameFor("+15550100999")).toBeUndefined();
  });

  test("matches an email whatever its case", () => {
    addContact(book, 1, {
      firstName: "Sarah",
      lastName: "Mendez",
      emails: ["Sarah.Mendez@Example.com"],
    });
    const index = buildHandleNameIndex([book]);
    expect(index.nameFor("sarah.mendez@example.com")).toBe("Sarah Mendez");
    expect(index.nameFor("SARAH.MENDEZ@EXAMPLE.COM")).toBe("Sarah Mendez");
  });

  test("uses the organization when a card has no personal name", () => {
    addContact(book, 1, { organization: "Studio Northstar", emails: ["desk@example.org"] });
    expect(buildHandleNameIndex([book]).nameFor("desk@example.org")).toBe("Studio Northstar");
  });

  test("a handle two cards name differently is ambiguous and has no name", () => {
    addContact(book, 1, { firstName: "Maya", lastName: "Reeves", phones: ["+15550100123"] });
    addContact(secondBook, 1, { firstName: "Jamie", lastName: "Lopez", phones: ["+15550100123"] });
    const index = buildHandleNameIndex([book, secondBook]);
    expect(index.lookup("+15550100123")).toEqual({
      kind: "ambiguous",
      names: ["Jamie Lopez", "Maya Reeves"],
    });
    expect(index.nameFor("+15550100123")).toBeUndefined();
    expect(index.ambiguousCount).toBe(1);
  });

  test("the same name on two cards is not ambiguous", () => {
    addContact(book, 1, { firstName: "Maya", lastName: "Reeves", phones: ["+15550100123"] });
    addContact(secondBook, 7, { firstName: "Maya", lastName: "Reeves", phones: ["+15550100123"] });
    expect(buildHandleNameIndex([book, secondBook]).nameFor("+15550100123")).toBe("Maya Reeves");
  });

  test("a card named only by a phone or an email gives no name", () => {
    addContact(book, 1, { firstName: "+1 555 010 0123", phones: ["+15550100123"] });
    addContact(book, 2, { firstName: "someone@example.com", emails: ["someone@example.com"] });
    const index = buildHandleNameIndex([book]);
    expect(index.nameFor("+15550100123")).toBeUndefined();
    expect(index.nameFor("someone@example.com")).toBeUndefined();
  });

  test("an empty index names nothing", () => {
    expect(HandleNameIndex.empty.nameFor("+15550100123")).toBeUndefined();
    expect(HandleNameIndex.empty.lookup("maya@example.com")).toEqual({ kind: "unknown" });
  });
});

describe("ContactNameDirectory", () => {
  let tmpDir: string;
  let book: Db;
  let stores: ContactsStore[];
  let reads: number;
  let directory: ContactNameDirectory;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "apple-contact-directory-"));
    book = createAddressBook(join(tmpDir, "a.abcddb"));
    addContact(book, 1, { firstName: "Maya", lastName: "Reeves", phones: ["+15550100123"] });
    stores = [{ kind: "open", key: "main", db: book }];
    reads = 0;
    directory = new ContactNameDirectory(() => {
      reads++;
      return stores;
    });
  });

  afterEach(() => {
    book.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("rebuilds only when the address books change", () => {
    const first = directory.current();
    expect(first.nameFor("+15550100123")).toBe("Maya Reeves");
    expect(directory.current()).toBe(first);

    renameContact(book, 1, { firstName: "Sarah", lastName: "Mendez" });
    const renamed = directory.current();
    expect(renamed).not.toBe(first);
    expect(renamed.nameFor("+15550100123")).toBe("Sarah Mendez");

    addContact(book, 2, { firstName: "Jamie", lastName: "Lopez", emails: ["jamie@example.com"] });
    expect(directory.current().nameFor("jamie@example.com")).toBe("Jamie Lopez");
    expect(reads).toBe(4);
  });

  test("is empty when the address books cannot be listed", () => {
    const failing = new ContactNameDirectory(() => {
      throw new Error("authorization denied");
    });
    expect(failing.current()).toBe(HandleNameIndex.empty);
    expect(failing.current()).toBe(HandleNameIndex.empty);
  });

  test("is empty when no address book could be read", () => {
    stores = [{ kind: "unavailable", key: "main", reason: "is unreadable" }];
    expect(directory.current()).toBe(HandleNameIndex.empty);
  });

  test("is empty when an address book has no contact table", () => {
    const broken = new Database(join(tmpDir, "broken.abcddb"));
    try {
      stores = [{ kind: "open", key: "main", db: broken }];
      expect(directory.current()).toBe(HandleNameIndex.empty);
    } finally {
      broken.close();
    }
  });

  test("keeps the last complete index through a partial read", () => {
    const complete = directory.current();
    expect(complete.nameFor("+15550100123")).toBe("Maya Reeves");

    stores = [{ kind: "unavailable", key: "main", reason: "is locked" }];
    expect(directory.current()).toBe(complete);

    stores = [{ kind: "open", key: "main", db: book }];
    renameContact(book, 1, { firstName: "Sarah", lastName: "Mendez" });
    expect(directory.current().nameFor("+15550100123")).toBe("Sarah Mendez");
  });
});
