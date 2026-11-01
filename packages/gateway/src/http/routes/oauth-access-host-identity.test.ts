// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { Hono } from "hono";
import { DeviceId, Scope, TokenId } from "@omnesis/types";
import { beforeEach, describe, expect, test } from "vitest";

import { AccessService } from "../../access/service.js";
import { createAccessLevel, defaultAuthorizationScope } from "../../access/store.js";
import { authorizeInteractiveAccess } from "../../access/test-utils.js";
import { runSchemaSetup } from "../../data/schema.js";
import { directWriteGate } from "../../write-gate.js";
import { errorResponse, HttpError } from "../errors.js";
import { mountOAuthAccessRoutes } from "./oauth-access.js";
import type { Db } from "../../data/types.js";
import type { AppEnv } from "./types.js";

const ORIGIN = "https://omnesis.example.org";
const RESOURCE = `${ORIGIN}/mcp`;
const ISSUER = "https://agents.example.org";
const CSRF = "csrf-test-token";
const PORTAL = { "X-Test-Portal": "yes", "X-Omnesis-CSRF": CSRF };

let db: Db;
let app: Hono<AppEnv>;
let connectionId: string;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
  const level = createAccessLevel(db, {
    name: "Agent host",
    rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
    actorTokenId: "portal-token",
  });
  if (!level.ok) throw new Error(level.error);
  connectionId = authorizeInteractiveAccess(db, {
    selection: {
      kind: "new-connection",
      name: "Fictional agent host",
      level: { kind: "existing", levelId: level.value.id, expectedLevelRevision: 1 },
    },
    resource: RESOURCE,
    scope: defaultAuthorizationScope(),
  }).principalId;
  app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    throw error;
  });
  app.use("*", async (c, next) => {
    if (c.req.header("X-Test-Portal") === "yes") {
      c.set("auth", {
        authMethod: "portal-session",
        deviceId: null,
        credentialDeviceId: null,
        tokenId: TokenId("00000000-0000-4000-8000-000000000001"),
        scopes: [Scope("admin")],
        csrfToken: CSRF,
      });
    } else if (c.req.header("X-Test-Bearer") === "yes") {
      c.set("auth", {
        authMethod: "bearer",
        deviceId: DeviceId("00000000-0000-4000-8000-000000000003"),
        tokenId: TokenId("00000000-0000-4000-8000-000000000002"),
        scopes: [Scope("admin")],
      });
    }
    await next();
  });
  mountOAuthAccessRoutes(app, new AccessService(db, directWriteGate(db)), {
    publicBaseUrl: ORIGIN,
    mcpResourceUrls: ["https://omnesis-alias.example.org/mcp"],
  });
});

async function bind(audience: string, headers: Record<string, string> = PORTAL) {
  const response = await app.request(
    `${ORIGIN}/admin/access/connections/${connectionId}/host-identity`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ issuer: ISSUER, audience }),
    },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("binding a connection to an agent host", () => {
  test("accepts any of the gateway's own MCP URLs, as the host saves them", async () => {
    expect(await bind(`${RESOURCE}/`)).toMatchObject({
      status: 200,
      body: { binding: { connectionId, issuer: ISSUER, audience: RESOURCE } },
    });
    expect(await bind("https://omnesis-alias.example.org/mcp")).toMatchObject({ status: 200 });
  });

  test("refuses an audience this gateway does not serve and names the ones it does", async () => {
    for (const audience of [
      "https://other.example.org/mcp",
      `${ORIGIN}/mcp/other`,
      `${RESOURCE}?k=1`,
    ]) {
      expect(await bind(audience)).toEqual({
        status: 400,
        body: {
          error: "audience-not-served",
          message: "The audience must be one of this gateway's MCP URLs.",
          servedAudiences: [RESOURCE, "https://omnesis-alias.example.org/mcp"],
        },
      });
    }
    const listed = await app.request(`${ORIGIN}/admin/access/host-identity`, { headers: PORTAL });
    expect(await listed.json()).toEqual({ bindings: [] });
  });

  test("is an access decision made from a portal session, not with a bearer token", async () => {
    expect((await bind(RESOURCE, { "X-Test-Bearer": "yes" })).status).toBe(403);
  });
});
