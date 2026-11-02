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

describe("the default level for a person's other agents", () => {
  const PERSON = "maya@example.com";
  let levelId: string;

  beforeEach(() => {
    const created = createAccessLevel(db, {
      name: "Answer only",
      rules: [
        {
          capability: "answer",
          sources: { mode: "all", sourceIds: [] },
          release: { mode: "unreviewed" },
        },
      ],
      actorTokenId: "portal-token",
    });
    if (!created.ok) throw new Error(created.error);
    levelId = created.value.id;
  });

  async function send(
    method: "PUT" | "DELETE",
    body: Record<string, unknown> | null,
    headers: Record<string, string> = PORTAL,
    person = PERSON,
  ) {
    const path = `${ORIGIN}/admin/access/connections/${connectionId}/host-agent-default`;
    const response = await app.request(
      method === "DELETE" ? `${path}?person=${encodeURIComponent(person)}` : path,
      {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function listed() {
    const response = await app.request(`${ORIGIN}/admin/access/host-identity`, {
      headers: PORTAL,
    });
    return (await response.json()) as {
      bindings: Array<{ agents: unknown[]; defaults: Array<Record<string, unknown>> }>;
    };
  }

  test("is set, listed apart from the agents and cleared from a portal session", async () => {
    expect(await send("PUT", { person: PERSON, levelId })).toMatchObject({ status: 409 });
    await bind(RESOURCE);
    expect(await send("PUT", { person: PERSON, levelId })).toMatchObject({
      status: 200,
      body: { default: { connectionId, person: PERSON, levelId, levelName: "Answer only" } },
    });
    expect((await listed()).bindings[0]).toMatchObject({
      agents: [],
      defaults: [{ person: PERSON, levelId }],
    });
    expect(await send("DELETE", null)).toEqual({ status: 200, body: { cleared: true } });
    expect((await listed()).bindings[0]?.defaults).toEqual([]);
    expect(await send("DELETE", null)).toEqual({ status: 404, body: { error: "not-found" } });
  });

  test("refuses a bearer token, a malformed person or level and an unknown connection", async () => {
    await bind(RESOURCE);
    expect(
      (await send("PUT", { person: PERSON, levelId }, { "X-Test-Bearer": "yes" })).status,
    ).toBe(403);
    expect((await send("DELETE", null, { "X-Test-Bearer": "yes" })).status).toBe(403);
    expect(await send("PUT", { person: "two words", levelId })).toEqual({
      status: 400,
      body: { error: "invalid-selection" },
    });
    expect((await send("PUT", { person: PERSON, levelId: "not-a-level" })).status).toBe(400);
    expect(
      await send("PUT", { person: PERSON, levelId: "00000000-0000-4000-8000-00000000ffff" }),
    ).toEqual({ status: 409, body: { error: "inactive-grant" } });
    const unknown = await app.request(
      `${ORIGIN}/admin/access/connections/00000000-0000-4000-8000-00000000eeee/host-agent-default`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...PORTAL },
        body: JSON.stringify({ person: PERSON, levelId }),
      },
    );
    expect(unknown.status).toBe(404);
    expect((await listed()).bindings[0]?.defaults).toEqual([]);
  });
});

describe("agent grants and the default together", () => {
  const PERSON = "maya@example.com";
  let readerLevel: string;

  beforeEach(async () => {
    const created = createAccessLevel(db, {
      name: "Reader",
      rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
      actorTokenId: "portal-token",
    });
    if (!created.ok) throw new Error(created.error);
    readerLevel = created.value.id;
    await bind(RESOURCE);
  });

  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = PORTAL,
  ) {
    const response = await app.request(`${ORIGIN}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const agentsPath = () => `/admin/access/connections/${connectionId}/host-agents`;
  const defaultPath = () => `/admin/access/connections/${connectionId}/host-agent-default`;

  async function setDefault() {
    return call("PUT", defaultPath(), { person: PERSON, levelId: readerLevel });
  }

  async function listed() {
    return (await call("GET", "/admin/access/host-identity")).body as {
      bindings: Array<{
        agents: Array<{ id: string; agent: string; levelId: string | null }>;
        defaults: Array<{ id: string }>;
      }>;
    };
  }

  test("denies an agent by name, and replaces its grant in one step", async () => {
    const denied = await call("POST", agentsPath(), {
      person: PERSON,
      agent: "instance:agent-a",
      levelId: null,
    });
    expect(denied).toMatchObject({ status: 201, body: { agent: { levelId: null } } });
    const replaced = await call("PUT", agentsPath(), {
      person: PERSON,
      agent: "instance:Agent-A",
      levelId: readerLevel,
    });
    expect(replaced).toMatchObject({
      status: 200,
      body: { agent: { agent: "instance:agent-a", levelId: readerLevel } },
    });
    expect((await listed()).bindings[0]?.agents).toEqual([
      expect.objectContaining({ agent: "instance:agent-a", levelId: readerLevel }),
    ]);
    expect(
      await call("POST", agentsPath(), { person: PERSON, agent: "instance:*", levelId: null }),
    ).toEqual({ status: 400, body: { error: "invalid-selection" } });
  });

  test("refuses to revoke an agent onto the default unless the default is meant", async () => {
    const created = await call("POST", agentsPath(), {
      person: PERSON,
      agent: "instance:agent-a",
      levelId: readerLevel,
    });
    const id = (created.body.agent as { id: string }).id;
    await setDefault();
    expect(await call("DELETE", `/admin/access/host-agents/${id}`)).toMatchObject({
      status: 409,
      body: { error: "default-would-apply" },
    });
    expect(await call("DELETE", `/admin/access/host-agents/${id}?fallback=other`)).toEqual({
      status: 400,
      body: { error: "invalid-selection" },
    });
    expect(await call("DELETE", `/admin/access/host-agents/${id}?fallback=default`)).toEqual({
      status: 200,
      body: { revoked: true, onDefault: true },
    });
    expect((await listed()).bindings[0]?.agents).toEqual([]);
  });

  test("clears a default only through the default route", async () => {
    const set = await setDefault();
    const defaultId = (set.body.default as { id: string }).id;
    expect(await call("DELETE", `/admin/access/host-agents/${defaultId}`)).toEqual({
      status: 404,
      body: { error: "not-found" },
    });
    expect(await call("DELETE", `/admin/access/host-agents/${defaultId}?fallback=default`)).toEqual(
      { status: 404, body: { error: "not-found" } },
    );
    expect((await listed()).bindings[0]?.defaults).toHaveLength(1);
  });

  test("refuses a default for anything but an email address, and odd requests", async () => {
    for (const person of ["*", "maya", "agents@example"]) {
      expect(await call("PUT", defaultPath(), { person, levelId: readerLevel })).toEqual({
        status: 400,
        body: { error: "invalid-selection" },
      });
    }
    expect(
      (await call("PUT", defaultPath(), { person: PERSON, levelId: readerLevel, agent: "*" }))
        .status,
    ).toBe(400);
    expect((await call("PUT", defaultPath(), { person: PERSON, levelId: null })).status).toBe(400);
    for (const query of ["", "?person=maya@example.com&x=1"]) {
      expect(await call("DELETE", `${defaultPath()}${query}`)).toEqual({
        status: 400,
        body: { error: "invalid-selection" },
      });
    }
    const noCsrf = { "X-Test-Portal": "yes" };
    const badCsrf = { "X-Test-Portal": "yes", "X-Omnesis-CSRF": "wrong" };
    for (const headers of [noCsrf, badCsrf]) {
      expect(
        (await call("PUT", defaultPath(), { person: PERSON, levelId: readerLevel }, headers))
          .status,
      ).toBe(403);
      expect(
        (await call("DELETE", `${defaultPath()}?person=${PERSON}`, undefined, headers)).status,
      ).toBe(403);
    }
    expect((await listed()).bindings[0]?.defaults).toEqual([]);
  });

  test("lists no binding for a removed connection, and still clears a default left on one", async () => {
    await setDefault();
    db.prepare("UPDATE access_principals SET revoked_at = 1 WHERE id = ?").run(connectionId);
    expect((await listed()).bindings).toEqual([]);
    expect(await call("DELETE", `${defaultPath()}?person=${PERSON}`)).toEqual({
      status: 200,
      body: { cleared: true },
    });
  });
});
