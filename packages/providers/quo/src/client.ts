// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import {
  quoContactSchema,
  quoListEnvelopeSchema,
  quoMessageSchema,
  quoOrganizationSchema,
  quoPhoneNumberSchema,
} from "./schemas.js";
import type { QuoContact, QuoMessage, QuoOrganization, QuoPhoneNumber } from "./schemas.js";

const log = createLogger("provider:quo").child("client");

/**
 * The API this package reads. Version `2026-03-30` is the first to list an
 * organization's messages across every number and conversation; the older v1
 * API at `api.openphone.com/v1` lists only one number's thread with named
 * participants. Every request pins the version, as Quo requires — there is no
 * default.
 */
const QUO_API_BASE = "https://api.quo.com";
const QUO_API_VERSION = "2026-03-30";

/** The largest page Quo serves. */
export const QUO_PAGE_LIMIT = 50;

/** Quo allows each key 10 requests a second; spacing requests keeps one sync under it. */
const MIN_REQUEST_SPACING_MS = 120;
/** A Retry-After at or below this is slept through inline; longer ones go to the scheduler. */
const MAX_INLINE_RETRY_MS = 10_000;
/** Retries of a rate-limited or failed request before the error reaches the scheduler. */
const MAX_RETRIES = 2;
/** First backoff after a server error; it doubles per retry. */
const SERVER_ERROR_BACKOFF_MS = 1_000;
/** Backoff when Quo answers 429 without a usable Retry-After. */
const DEFAULT_RATE_LIMIT_MS = 1_000;
/** Most numbers one contact search may name, and the only page size it accepts. */
export const QUO_CONTACT_SEARCH_MAX = 50;
/** Bound on phone-number pages, so a server that never stops paging cannot loop forever. */
const MAX_PHONE_NUMBER_PAGES = 100;
/** Longest error detail placed in a message. */
const MAX_DETAIL_LEN = 200;

export interface QuoClientOptions {
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Spacing between requests. Injectable so tests need not wait. */
  minSpacingMs?: number;
}

export interface ListMessagesParams {
  /** Exclusive lower bound on `createdAt`. */
  createdAfter?: string;
  /** Exclusive upper bound on `createdAt`. */
  createdBefore?: string;
  /** Quo's `nextCursor` from the previous page of the same query. */
  after?: string;
  limit?: number;
}

export interface MessagePage {
  messages: QuoMessage[];
  /** Records in the page that did not parse and were left out. */
  malformed: number;
  nextCursor: string | null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Thin client for the Quo REST API, authenticated with an organization API
 * key sent as-is in `Authorization` (no `Bearer` prefix). Failures become
 * `SyncError`s the collector classifies: `auth` parks the source until the
 * key is replaced, `permission` names what to change in Quo, `rate-limit`
 * carries the wait, and `transient` / `network` retry on the next tick.
 */
export class QuoClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minSpacingMs: number;
  private lastRequestAt = Number.NEGATIVE_INFINITY;

  constructor(apiKey: string, opts: QuoClientOptions = {}) {
    this.apiKey = apiKey;
    this.baseUrl = opts.baseUrl ?? QUO_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.minSpacingMs = opts.minSpacingMs ?? MIN_REQUEST_SPACING_MS;
  }

  /** The organization the key belongs to. Doubles as the auth flow's probe. */
  async getOrganization(signal?: AbortSignal): Promise<QuoOrganization> {
    const body = await this.request("/organization", new URLSearchParams(), signal);
    const parsed = quoOrganizationSchema.safeParse(body);
    if (!parsed.success) throw invalid("organization");
    return parsed.data.data;
  }

  /** Every phone number in the organization. */
  async listPhoneNumbers(signal?: AbortSignal): Promise<QuoPhoneNumber[]> {
    const out: QuoPhoneNumber[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PHONE_NUMBER_PAGES; page++) {
      const query = new URLSearchParams({ limit: String(QUO_PAGE_LIMIT) });
      if (after) query.set("after", after);
      const envelope = parseEnvelope(
        await this.request("/phone-numbers", query, signal),
        "phone number list",
      );
      for (const item of envelope.data) {
        const parsed = quoPhoneNumberSchema.safeParse(item);
        if (parsed.success) out.push(parsed.data);
      }
      if (!envelope.nextCursor || envelope.nextCursor === after) return out;
      after = envelope.nextCursor;
    }
    throw new SyncError("unknown", "Quo kept paging phone numbers past its safe page limit.");
  }

  /**
   * The workspace's contacts that carry any of these E.164 numbers, each with
   * its phone and email properties. Quo matches numbers exactly.
   */
  async searchContactsByPhone(
    phones: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ contacts: QuoContact[]; truncated: boolean }> {
    if (phones.length === 0) return { contacts: [], truncated: false };
    if (phones.length > QUO_CONTACT_SEARCH_MAX) {
      throw new Error(`A Quo contact search takes at most ${QUO_CONTACT_SEARCH_MAX} numbers`);
    }
    const query = new URLSearchParams({
      limit: String(QUO_CONTACT_SEARCH_MAX),
      include: "properties",
      "phoneNumber[in]": phones.join(","),
    });
    const envelope = parseEnvelope(
      await this.request("/contacts/search", query, signal),
      "contact search",
    );
    const contacts: QuoContact[] = [];
    for (const item of envelope.data) {
      const parsed = quoContactSchema.safeParse(item);
      if (parsed.success) contacts.push(parsed.data);
    }
    return { contacts, truncated: Boolean(envelope.nextCursor) };
  }

  /** One page of the organization's messages, newest first. */
  async listMessages(params: ListMessagesParams, signal?: AbortSignal): Promise<MessagePage> {
    const query = new URLSearchParams({ limit: String(params.limit ?? QUO_PAGE_LIMIT) });
    if (params.createdAfter) query.set("createdAt[gt]", params.createdAfter);
    if (params.createdBefore) query.set("createdAt[lt]", params.createdBefore);
    if (params.after) query.set("after", params.after);
    const envelope = parseEnvelope(await this.request("/messages", query, signal), "message list");
    const messages: QuoMessage[] = [];
    let malformed = 0;
    for (const item of envelope.data) {
      const parsed = quoMessageSchema.safeParse(item);
      if (parsed.success) messages.push(parsed.data);
      else malformed++;
    }
    return { messages, malformed, nextCursor: envelope.nextCursor ?? null };
  }

  private async request(
    path: string,
    query: URLSearchParams,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const qs = query.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: {
            Authorization: this.apiKey,
            "Quo-Api-Version": QUO_API_VERSION,
            Accept: "application/json",
          },
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new SyncError("network", `Could not reach Quo: ${(err as Error).message}`, {
          cause: err,
        });
      }

      if (res.ok) {
        try {
          return await res.json();
        } catch (err) {
          throw new SyncError("unknown", `Quo answered ${path} with something other than JSON.`, {
            cause: err,
          });
        }
      }

      if (res.status === 429) {
        const waitMs = parseRetryAfterMs(res.headers.get("retry-after"), this.now());
        await discard(res);
        const backoff = waitMs ?? DEFAULT_RATE_LIMIT_MS * 2 ** attempt;
        if (attempt < MAX_RETRIES && backoff <= MAX_INLINE_RETRY_MS) {
          log.info(`Quo rate limit on ${path}; retrying in ${backoff}ms`);
          await this.sleep(backoff);
          continue;
        }
        // Quo counts requests per API key, and every key belongs to one
        // organization, so the budget is this account's own.
        throw new SyncError("rate-limit", "Quo rate limit exceeded (HTTP 429).", {
          retryAfterMs: backoff,
          quota: { kind: "account" },
        });
      }

      if (res.status >= 500) {
        const detail = await errorDetail(res);
        if (attempt < MAX_RETRIES) {
          const backoff = SERVER_ERROR_BACKOFF_MS * 2 ** attempt;
          log.info(`Quo server error ${res.status} on ${path}; retrying in ${backoff}ms`);
          await this.sleep(backoff);
          continue;
        }
        throw new SyncError(
          "transient",
          `Quo server error (HTTP ${res.status})${detail ? `: ${detail}` : "."}`,
        );
      }

      throw await clientError(res, path);
    }
  }

  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.minSpacingMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }
}

/** A 4xx other than 429, as the error the operator reads. */
async function clientError(res: Response, path: string): Promise<SyncError> {
  const detail = await errorDetail(res);
  const suffix = detail ? `: ${detail}` : ".";
  // 401 is the key itself: every source on this organization is affected, and
  // only a new key fixes it.
  if (res.status === 401) {
    return new SyncError("auth", `Quo rejected the API key (HTTP 401)${suffix}`, {
      scope: "connection",
      remediation: {
        summary: "Quo no longer accepts this API key",
        steps: [
          "In Quo, open Workspace Settings, then API, and generate a new key (owner or admin only).",
          "Re-authenticate this source with the new key.",
        ],
        restartRequired: false,
      },
    });
  }
  // 403 is a key Quo recognises but will not serve: a lapsed subscription or
  // a workspace setting. A new key changes nothing.
  if (res.status === 403) {
    return new SyncError("permission", `Quo refused ${path} (HTTP 403)${suffix}`, {
      remediation: {
        summary: "Quo accepts the key but will not serve messages to it",
        steps: [
          "Check that the Quo workspace's subscription is active and that API access is enabled under Workspace Settings, then API.",
        ],
        restartRequired: false,
      },
    });
  }
  return new SyncError("unknown", `Quo request to ${path} failed (HTTP ${res.status})${suffix}`);
}

function parseEnvelope(body: unknown, what: string) {
  const parsed = quoListEnvelopeSchema.safeParse(body);
  if (!parsed.success) throw invalid(what);
  return parsed.data;
}

function invalid(what: string): SyncError {
  return new SyncError("unknown", `Quo returned an invalid ${what}.`);
}

/** Retry-After is delta-seconds or an HTTP date. */
export function parseRetryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (header.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

/**
 * The reason in Quo's error envelope (`{title, message, trace, errors}`), or
 * the raw body. The trace id is kept: it is what Quo support asks for.
 */
async function errorDetail(res: Response): Promise<string | undefined> {
  let body: string;
  try {
    body = await res.text();
  } catch {
    return undefined;
  }
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { message?: unknown; trace?: unknown };
    if (typeof parsed.message === "string") {
      const trace = typeof parsed.trace === "string" ? ` (trace ${parsed.trace})` : "";
      return truncate(`${parsed.message}${trace}`);
    }
  } catch {
    // Not Quo's envelope: a proxy's page, say.
  }
  return truncate(body);
}

function truncate(text: string): string {
  return text.length > MAX_DETAIL_LEN ? `${text.slice(0, MAX_DETAIL_LEN)}…` : text;
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}
