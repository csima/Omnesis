// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * An in-memory Quo API (version `2026-03-30`) for tests: the endpoints the
 * source reads, with the `createdAt` range filter, newest-first order, cursor
 * paging and the error envelope it relies on. Every value in it is invented,
 * and every number is in the fictional +1 (555) 010-0xxx range.
 */

export const FAKE_API_KEY = "quo-test-key-0123456789";
export const FAKE_ORG_ID = "ORnorthstar01";
export const FAKE_ORG_NAME = "Studio Northstar";

/** The workspace's own numbers. */
export const MAIN_LINE = { id: "PNmainline01", phoneNumber: "+15550100100", name: "Main line" };
export const SUPPORT_LINE = { id: "PNsupport02", phoneNumber: "+15550100200", name: "Support" };

/** Outside parties. */
export const MAYA = "+15550100111";
export const JAMIE = "+15550100122";
export const DAVID = "+15550100133";

export interface FakeContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  phones: string[];
}

export interface FakeMessage {
  id: string;
  from: string;
  to: string[];
  text: string;
  phoneNumberId: string | null;
  conversationId: string;
  direction: "incoming" | "outgoing";
  userId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  media: Array<{ url: string; type: string | null }>;
}

export class FakeQuo {
  readonly messages: Array<FakeMessage | Record<string, unknown>> = [];
  readonly phoneNumbers = [MAIN_LINE, SUPPORT_LINE];
  readonly contacts: FakeContact[] = [];
  orgId = FAKE_ORG_ID;
  /** Every request path served, with its query, decoded. */
  readonly requests: string[] = [];
  /** Answer the next request whose path contains `match` with this response instead. */
  failNext: Array<{
    match: string;
    status: number;
    body?: string;
    headers?: Record<string, string>;
  }> = [];
  /** While set, every request fails with this status. */
  outage: number | undefined;
  private seq = 0;

  /** Add a message; `createdAt` defaults to one second after the previous one. */
  add(message: Partial<FakeMessage> & Pick<FakeMessage, "direction">): FakeMessage {
    this.seq += 1;
    const createdAt =
      message.createdAt ?? new Date(Date.UTC(2026, 9, 1, 9, 0, 0) + this.seq * 1000).toISOString();
    const outgoing = message.direction === "outgoing";
    const full: FakeMessage = {
      id: `ACmsg${String(this.seq).padStart(4, "0")}`,
      from: outgoing ? MAIN_LINE.phoneNumber : MAYA,
      to: outgoing ? [MAYA] : [MAIN_LINE.phoneNumber],
      text: `Message ${this.seq}`,
      phoneNumberId: MAIN_LINE.id,
      conversationId: "CNmaya0001",
      userId: outgoing ? "USowner001" : null,
      status: outgoing ? "delivered" : "received",
      updatedAt: createdAt,
      media: [],
      ...message,
      createdAt,
    };
    this.messages.push(full);
    return full;
  }

  /** Add a workspace contact carrying these numbers. */
  addContact(contact: Partial<FakeContact> & Pick<FakeContact, "phones">): FakeContact {
    const full: FakeContact = {
      id: `CT${String(this.contacts.length + 1).padStart(4, "0")}`,
      firstName: null,
      lastName: null,
      company: null,
      ...contact,
    };
    this.contacts.push(full);
    return full;
  }

  /** Put a record in the list as-is, whatever its shape. */
  addRaw(record: Record<string, unknown>): void {
    this.messages.push(record);
  }

  readonly fetch: typeof fetch = (input, init) => Promise.resolve(this.respond(input, init));

  private respond(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): Response {
    const url = new URL(String(input));
    this.requests.push(`${url.pathname}${decodeURIComponent(url.search)}`);
    const headers = new Headers(init?.headers);
    if (this.outage) return error(this.outage, "Unexpected");
    const failure = this.failNext.findIndex((f) => url.pathname.includes(f.match));
    if (failure >= 0) {
      const [f] = this.failNext.splice(failure, 1);
      return new Response(f!.body ?? JSON.stringify({ title: "Error", message: "failure" }), {
        status: f!.status,
        headers: f!.headers,
      });
    }
    if (headers.get("authorization") !== FAKE_API_KEY) return error(401, "Unauthorized");
    if (headers.get("quo-api-version") !== "2026-03-30") {
      return error(400, "The Quo-Api-Version header is required");
    }
    const q = url.searchParams;
    switch (url.pathname) {
      case "/organization":
        return json({
          data: {
            id: this.orgId,
            name: FAKE_ORG_NAME,
            subscriptionStatus: "active",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          },
        });
      case "/phone-numbers":
        return json(page(this.phoneNumbers, q));
      case "/messages":
        return json(page(this.listMessages(q), q));
      case "/contacts/search":
        return this.searchContacts(q);
      default:
        return error(404, "Not Found");
    }
  }

  private searchContacts(q: URLSearchParams): Response {
    if (q.get("limit") !== "50") return error(400, "limit must be 50");
    const wanted = (q.get("phoneNumber[in]") ?? q.get("phoneNumber") ?? "").split(",");
    if (wanted.length > 50) return error(400, "At most 50 phone numbers");
    const matches = this.contacts.filter((c) => c.phones.some((p) => wanted.includes(p)));
    const withProperties = q.get("include") === "properties";
    return json({
      data: matches.slice(0, 50).map((c) => ({
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        company: c.company,
        role: null,
        source: "public-api",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
        ...(withProperties
          ? { properties: c.phones.map((value) => ({ type: "phone-number", value })) }
          : {}),
      })),
      nextCursor: matches.length > 50 ? "more" : null,
    });
  }

  private listMessages(q: URLSearchParams) {
    const gt = q.get("createdAt[gt]");
    const lt = q.get("createdAt[lt]");
    return this.messages
      .filter((m) => {
        const at = Date.parse(String(m.createdAt));
        if (gt && !(at > Date.parse(gt))) return false;
        if (lt && !(at < Date.parse(lt))) return false;
        return true;
      })
      .sort(
        (a, b) =>
          Date.parse(String(b.createdAt)) - Date.parse(String(a.createdAt)) ||
          String(b.id).localeCompare(String(a.id)),
      );
  }
}

function page<T>(all: T[], q: URLSearchParams) {
  const limit = Number(q.get("limit") ?? 10);
  const start = q.get("after") ? Number(Buffer.from(q.get("after")!, "base64url").toString()) : 0;
  const data = all.slice(start, start + limit);
  const next =
    start + limit < all.length ? Buffer.from(String(start + limit)).toString("base64url") : null;
  return { data, nextCursor: next };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(status: number, title: string): Response {
  return json({ title, message: title, docs: "https://quo.com/docs", trace: "1234567890" }, status);
}
