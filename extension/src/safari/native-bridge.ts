// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isAllowedNativeRequest } from "./native-contract.js";
import type { FetchLike, FetchLikeResponse } from "../push/types.js";

/**
 * The Safari extension's only way out: messages to the iPhone app's extension
 * handler, which holds the gateway address, the capture credential and the
 * certificate pin. Nothing here learns any of the three. A request names a
 * path on the paired gateway and the handler decides whether to send it.
 */
export type NativeMessage =
  { type: "status" } | { type: "request"; method: string; path: string; body?: string };

export type NativeStatus =
  { paired: true; deviceId: string; gatewayHost: string } | { paired: false };

export type NativeRequestFailure = "unpaired" | "refused" | "network";

export type NativeResponse =
  | { ok: true; status: number; body: string; retryAfter?: string }
  | { ok: false; reason: NativeRequestFailure };

export type SendNativeMessage = (message: NativeMessage) => Promise<unknown>;

/** The origin the push client addresses; the handler reads only the path. */
export const SAFARI_GATEWAY_ORIGIN = "https://gateway.omnesis.invalid";

/** A handler that does not answer must not hold a capture or a drain. */
export const NATIVE_MESSAGE_TIMEOUT_MS = 20_000;

const MAX_DEVICE_ID_CHARS = 128;
const MAX_GATEWAY_HOST_CHARS = 255;

export function parseNativeStatus(raw: unknown): NativeStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const status = raw as { paired?: unknown; deviceId?: unknown; gatewayHost?: unknown };
  if (status.paired === false) return { paired: false };
  if (
    status.paired !== true ||
    typeof status.deviceId !== "string" ||
    status.deviceId.length === 0 ||
    status.deviceId.length > MAX_DEVICE_ID_CHARS ||
    typeof status.gatewayHost !== "string" ||
    status.gatewayHost.length === 0 ||
    status.gatewayHost.length > MAX_GATEWAY_HOST_CHARS
  ) {
    return null;
  }
  return { paired: true, deviceId: status.deviceId, gatewayHost: status.gatewayHost };
}

export function parseNativeResponse(raw: unknown): NativeResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const response = raw as {
    ok?: unknown;
    status?: unknown;
    body?: unknown;
    retryAfter?: unknown;
    reason?: unknown;
  };
  if (response.ok === false) {
    return response.reason === "unpaired" ||
      response.reason === "refused" ||
      response.reason === "network"
      ? { ok: false, reason: response.reason }
      : null;
  }
  if (
    response.ok !== true ||
    typeof response.status !== "number" ||
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    typeof response.body !== "string"
  ) {
    return null;
  }
  return {
    ok: true,
    status: response.status,
    body: response.body,
    ...(typeof response.retryAfter === "string" ? { retryAfter: response.retryAfter } : {}),
  };
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", fail);
      reject(new TypeError("The Omnesis app did not answer"));
    };
    const timer = setTimeout(fail, timeoutMs);
    if (signal?.aborted) {
      fail();
      return;
    }
    signal?.addEventListener("abort", fail, { once: true });
    work.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", fail);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", fail);
        reject(error instanceof Error ? error : new TypeError(String(error)));
      },
    );
  });
}

export async function readNativeStatus(
  send: SendNativeMessage,
  timeoutMs = NATIVE_MESSAGE_TIMEOUT_MS,
): Promise<NativeStatus | null> {
  try {
    return parseNativeStatus(await withDeadline(send({ type: "status" }), timeoutMs));
  } catch {
    return null;
  }
}

function response(status: number, body: string, retryAfter?: string): FetchLikeResponse {
  return {
    status,
    headers: {
      get: (name) => (name.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null),
    },
    text: () => Promise.resolve(body),
  };
}

/**
 * A `FetchLike` that reaches the gateway through the app. The caller's
 * authorization header and origin are dropped here and again by the handler:
 * the app attaches its own credential to its own gateway. An app with no
 * pairing reads as an unauthorized gateway, which the push client keeps its
 * queue for; an unreachable app or gateway reads as a network failure.
 */
export function createNativeFetch(
  send: SendNativeMessage,
  options: { timeoutMs?: number; onUnpaired?: () => void } = {},
): FetchLike {
  const timeoutMs = options.timeoutMs ?? NATIVE_MESSAGE_TIMEOUT_MS;
  return async (input, init) => {
    const url = new URL(input);
    const path = `${url.pathname}${url.search}`;
    // The app refuses anything outside the contract; do not ask it to.
    if (!isAllowedNativeRequest(init.method, path)) return response(400, "");
    const hasBody = init.method !== "GET" && init.method !== "HEAD" && init.body !== "";
    const raw = await withDeadline(
      send({
        type: "request",
        method: init.method,
        path,
        ...(hasBody ? { body: init.body } : {}),
      }),
      timeoutMs,
      init.signal,
    );
    const parsed = parseNativeResponse(raw);
    if (!parsed) throw new TypeError("The Omnesis app sent an unreadable answer");
    if (parsed.ok) return response(parsed.status, parsed.body, parsed.retryAfter);
    if (parsed.reason === "unpaired") {
      options.onUnpaired?.();
      return response(401, "");
    }
    if (parsed.reason === "refused") return response(400, "");
    throw new TypeError("The gateway could not be reached");
  };
}
