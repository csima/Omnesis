// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-route request-body validation at the route boundary, backed by zod.
 *
 * Every POST/PATCH/PUT route that takes a JSON body should declare its body
 * shape as a zod schema in `http/schemas/<route>.ts` and mount the schema
 * via `validateJson(schema)`. The handler then reads the parsed value via
 * `c.req.valid("json")` — typed as `z.infer<typeof schema>` — instead of
 * `await c.req.json()`.
 *
 * Failures throw a `ValidationError`, which the central `app.onError`
 * (server.ts) renders as the canonical 400 envelope:
 *   { error: "Validation failed",
 *     code:  "VALIDATION_ERROR",
 *     detail: [{ path, message }, ...] }
 * where `path` is an RFC 6901 JSON pointer (e.g. `/sources/0/accountId`),
 * matching the convention already established by `validateConfig` in
 * `@omnesis/core/config-schema.ts`.
 *
 * Hono's `validator("json", ...)` handles malformed-JSON requests by
 * throwing `HTTPException(400, { message: "Malformed JSON in request body" })`,
 * which the gateway's central error handler renders as a 400.
 *
 * That catch also swallows a body that never finished arriving: a phone
 * suspended mid-upload, a dropped link, a proxy abandoning a slow request.
 * Those are not malformed payloads, and a client that reads the 400 as a
 * verdict on its data would eventually discard it. `validateJson` therefore
 * reads the whole body first and answers 408 `REQUEST_BODY_INCOMPLETE` when
 * the read fails or ends short of `Content-Length`; only a complete body
 * that does not parse is still a 400.
 */
import { validator } from "hono/validator";
import { toJsonPointer } from "@omnesis/config";
import { RequestBodyIncompleteError, ValidationError } from "./errors.js";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./routes/types.js";
import type { ZodTypeAny, z } from "zod";

/**
 * Observe the exact bytes rejected by Hono's JSON parser without changing the
 * validation response. The request clone is made before the validator consumes
 * the body; callers decide how much of the body is safe to retain in logs.
 */
export function observeMalformedJson(
  onMalformed: (body: string) => void,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.header("content-type")?.toLowerCase().includes("application/json")) {
      try {
        const body = await c.req.raw.clone().text();
        try {
          JSON.parse(body);
        } catch {
          onMalformed(body);
        }
      } catch {
        // The production validator remains authoritative for the response.
      }
    }
    await next();
  };
}

export function validateJson<S extends ZodTypeAny>(schema: S) {
  const validate = validator("json", (value, _c) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError(
        "Validation failed",
        result.error.issues.map((issue) => ({
          path: toJsonPointer(pointerPath(issue.path)),
          message: issue.message,
        })),
      );
    }
    return result.data as z.infer<S>;
  });
  // The wrapper keeps the validator's own type, which is what carries the
  // parsed body's type through to `c.req.valid("json")`.
  const readThenValidate: typeof validate = async (c, next) => {
    await requireCompleteJsonBody(c);
    return validate(c, next);
  };
  return readThenValidate;
}

/** The content types Hono's JSON validator parses (its own `jsonRegex`). */
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

/**
 * Read a JSON request's body to the end before the validator parses it, so a
 * body cut off in transit is told apart from one that is malformed. Hono
 * caches the bytes on the request, so the validator parses this same read.
 * Requests the validator would not parse (no JSON content type) are left
 * alone, keeping its "no body means {}" behaviour.
 */
async function requireCompleteJsonBody(c: Context): Promise<void> {
  const contentType = c.req.header("content-type");
  if (!contentType || !JSON_CONTENT_TYPE.test(contentType)) {
    return;
  }
  const declared = Number(c.req.header("content-length"));
  let received: number;
  try {
    received = (await c.req.arrayBuffer()).byteLength;
  } catch {
    throw new RequestBodyIncompleteError(
      Number.isFinite(declared)
        ? `Request body ended before its declared ${declared} bytes arrived`
        : "Request body ended before it was complete",
    );
  }
  if (Number.isFinite(declared) && received < declared) {
    throw new RequestBodyIncompleteError(
      `Request body ended after ${received} of its declared ${declared} bytes`,
    );
  }
}

/**
 * Query-string sibling of {@link validateJson}: validates `c.req.query()`
 * against a zod schema (typically all-`z.coerce` fields, since every query
 * value arrives as a string). Read the parsed value via
 * `c.req.valid("query")`. Failures render the same canonical
 * VALIDATION_ERROR envelope with RFC 6901 pointers.
 */
export function validateQuery<S extends ZodTypeAny>(schema: S) {
  return validator("query", (value, _c) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError(
        "Validation failed",
        result.error.issues.map((issue) => ({
          path: toJsonPointer(pointerPath(issue.path)),
          message: issue.message,
        })),
      );
    }
    return result.data as z.infer<S>;
  });
}

function pointerPath(path: readonly PropertyKey[]): (string | number)[] {
  return path.filter(
    (seg): seg is string | number => typeof seg === "string" || typeof seg === "number",
  );
}
