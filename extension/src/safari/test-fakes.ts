// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { WebCapturePolicy } from "@omnesis/provider-web/capture-policy";
import type { NativeMessage } from "./native-bridge.js";
import type { SafariStorageArea } from "./storage.js";

/** `storage.local` as Safari gives it to an extension, held in memory. */
export class MemoryStorageArea implements SafariStorageArea {
  readonly data = new Map<string, unknown>();

  get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const wanted = keys === null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const key of wanted) if (this.data.has(key)) out[key] = this.data.get(key);
    return Promise.resolve(out);
  }
  set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data.set(key, value);
    return Promise.resolve();
  }
  remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key);
    return Promise.resolve();
  }
}

export function capturePolicy(overrides: Partial<WebCapturePolicy> = {}): WebCapturePolicy {
  return {
    updatedAt: "2026-03-01T09:00:00.000Z",
    pause: null,
    excludedDomains: [],
    screenshots: { enabled: false },
    ownedDomains: [],
    ownSites: [],
    rules: { skipPasswordForms: true, skipPathSegments: [] },
    removedPages: [],
    removedPagesTruncated: false,
    ...overrides,
  };
}

export interface NativeRequest {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * The iPhone app's side of the bridge, for tests: a pairing that can be made
 * and removed, a gateway that can be taken offline, and the capture settings
 * the gateway would hold.
 */
export class FakeNativeApp {
  pairing: { deviceId: string; gatewayHost: string } | null = {
    deviceId: "3f0c1a52-6d0b-4a55-9d3e-0c1f5b7a9e10",
    gatewayHost: "gateway.example.com",
  };
  online = true;
  /** The gateway no longer accepts the credential the app holds. */
  credentialRefused = false;
  policy = capturePolicy();
  readonly requests: NativeRequest[] = [];
  statusReads = 0;

  readonly send = (message: NativeMessage): Promise<unknown> => {
    if (message.type === "status") {
      this.statusReads += 1;
      return Promise.resolve(this.pairing ? { paired: true, ...this.pairing } : { paired: false });
    }
    if (!this.pairing || message.deviceId !== this.pairing.deviceId) {
      return Promise.resolve({ ok: false, reason: "unpaired" });
    }
    if (!this.online) return Promise.resolve({ ok: false, reason: "network" });
    const body = message.body === undefined ? undefined : (JSON.parse(message.body) as unknown);
    if (this.credentialRefused) {
      return Promise.resolve({ ok: true, status: 401, body: '{"error":"unauthorized"}' });
    }
    this.requests.push({ method: message.method, path: message.path, body });
    return Promise.resolve(this.answer(message.method, message.path, body));
  };

  private answer(method: string, path: string, body: unknown): unknown {
    const ok = (payload: unknown): unknown => ({
      ok: true,
      status: 200,
      body: JSON.stringify(payload),
    });
    if (method === "GET" && path === "/web-capture-policy") return ok(this.policy);
    if (method === "PUT" && path === "/web-capture-policy/pause") {
      this.policy = { ...this.policy, pause: { until: (body as { until: number | null }).until } };
      return ok(this.policy);
    }
    if (method === "DELETE" && path === "/web-capture-policy/pause") {
      this.policy = { ...this.policy, pause: null };
      return ok(this.policy);
    }
    if (method === "POST" && path === "/web-capture-policy/excluded-domains") {
      const { domain } = body as { domain: string };
      this.policy = {
        ...this.policy,
        excludedDomains: [...this.policy.excludedDomains, domain],
      };
      return ok({ policy: this.policy, purged: 0 });
    }
    if (method === "DELETE" && path.startsWith("/web-capture-policy/excluded-domains/")) {
      const domain = decodeURIComponent(path.split("/").pop() ?? "");
      this.policy = {
        ...this.policy,
        excludedDomains: this.policy.excludedDomains.filter((entry) => entry !== domain),
      };
      return ok(this.policy);
    }
    if (method === "POST" && path === "/documents") {
      return ok({ ingested: (body as { documents: unknown[] }).documents.length });
    }
    if (method === "POST" && path === "/analytics/ingest") return ok({ ingested: 1, deleted: 0 });
    return { ok: false, reason: "refused" };
  }

  /** Requests that carried something to store; the empty credential check is not one. */
  delivered(path: string): NativeRequest[] {
    return this.requests.filter(
      (request) =>
        request.method === "POST" &&
        request.path === path &&
        (request.body as { documents?: unknown[] }).documents?.length !== 0,
    );
  }
}
