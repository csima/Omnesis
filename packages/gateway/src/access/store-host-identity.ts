// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";

import {
  isHostPersonEmail,
  normalizeHostAgentGrantName,
  normalizeHostAudience,
  normalizeHostIssuer,
  normalizeHostPerson,
} from "./host-identity.js";
import { appendAudit, isUniqueConstraint } from "./store-helpers.js";
import { getLiveLevelRow } from "./store-level-summaries.js";
import { getConnectionGrant } from "./store-levels.js";
import { getLevelCapabilities } from "./store-rules.js";
import type { Db } from "../data/types.js";
import type { AccessMutationResult } from "./store-contracts.js";
import type {
  AccessGrantCapability,
  HostAgentAuthority,
  HostAgentDefault,
  HostAgentDefaultInput,
  HostAgentGrant,
  HostAgentGrantCreateInput,
  HostAgentGrantRevokeInput,
  HostIdentityBinding,
  HostIdentityBindingInput,
  HostIdentityOverview,
  HostIdentityUnbindInput,
} from "./types.js";

/**
 * The `agent` of a person's default grant row. No agent can be named this:
 * an assertion's agents and a grant's agent are both `instance:<id>`.
 */
export const HOST_AGENT_DEFAULT = "*";

interface BindingRow {
  principal_id: string;
  issuer: string;
  audience: string;
  created_at: number;
  updated_at: number;
}

interface AgentGrantRow {
  id: string;
  principal_id: string;
  person: string;
  agent: string;
  level_id: string | null;
  level_name: string | null;
  created_at: number;
  revoked_at: number | null;
}

function hasHostIdentityTables(db: Db): boolean {
  return (
    db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'access_host_agent_grants'",
      )
      .get() !== undefined
  );
}

function bindingFromRow(row: BindingRow): HostIdentityBinding {
  return {
    connectionId: row.principal_id,
    issuer: row.issuer,
    audience: row.audience,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function agentDefaultFromRow(row: AgentGrantRow): HostAgentDefault {
  return {
    id: row.id,
    connectionId: row.principal_id,
    person: row.person,
    levelId: row.level_id ?? "",
    levelName: row.level_name,
    createdAt: row.created_at,
  };
}

function agentGrantFromRow(row: AgentGrantRow): HostAgentGrant {
  return {
    id: row.id,
    connectionId: row.principal_id,
    person: row.person,
    agent: row.agent,
    levelId: row.level_id,
    levelName: row.level_name,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/** The agent host a connection is bound to, or null for an ordinary connection. */
export function getHostIdentityBinding(db: Db, connectionId: string): HostIdentityBinding | null {
  if (!hasHostIdentityTables(db)) return null;
  const row = db
    .prepare<[string], BindingRow>(
      "SELECT * FROM access_host_identity_bindings WHERE principal_id = ?",
    )
    .get(connectionId);
  return row ? bindingFromRow(row) : null;
}

/**
 * Every bound connection that is still live, its live host agent grants and
 * each person's default. A removed connection's binding is not listed: nothing
 * can call through it, and removing it releases its host access.
 */
export function listHostIdentity(db: Db, now = Date.now()): HostIdentityOverview {
  if (!hasHostIdentityTables(db)) return { bindings: [] };
  const bindings = db
    .prepare<[], BindingRow>(
      "SELECT * FROM access_host_identity_bindings ORDER BY created_at, principal_id",
    )
    .all()
    .filter((row) => getConnectionGrant(db, row.principal_id, now) !== null);
  const grants = db.prepare<[string], AgentGrantRow>(
    `SELECT h.*, l.name AS level_name
       FROM access_host_agent_grants h
       LEFT JOIN access_levels l ON l.id = h.level_id AND l.revoked_at IS NULL
      WHERE h.principal_id = ? AND h.revoked_at IS NULL
      ORDER BY h.person, h.agent`,
  );
  return {
    bindings: bindings.map((row) => {
      const live = grants.all(row.principal_id);
      return {
        ...bindingFromRow(row),
        agents: live.filter((grant) => grant.agent !== HOST_AGENT_DEFAULT).map(agentGrantFromRow),
        defaults: live
          .filter((grant) => grant.agent === HOST_AGENT_DEFAULT)
          .map(agentDefaultFromRow),
      };
    }),
  };
}

/**
 * Bind a live connection to an agent host, or change the host it is bound
 * to. Changing the issuer or audience revokes every agent grant made under
 * the old one: a grant names an agent of one particular host.
 */
export function setHostIdentityBinding(
  db: Db,
  input: HostIdentityBindingInput,
  now = Date.now(),
): AccessMutationResult<HostIdentityBinding> {
  const issuer = normalizeHostIssuer(input.issuer);
  const audience = normalizeHostAudience(input.audience);
  if (!issuer || !audience) return { ok: false, error: "invalid-selection" };
  return db.transaction((): AccessMutationResult<HostIdentityBinding> => {
    if (!getConnectionGrant(db, input.connectionId, now)) return { ok: false, error: "not-found" };
    const existing = getHostIdentityBinding(db, input.connectionId);
    if (existing && (existing.issuer !== issuer || existing.audience !== audience)) {
      revokeConnectionAgentGrants(db, input.connectionId, now);
    }
    db.prepare(
      `INSERT INTO access_host_identity_bindings (principal_id, issuer, audience, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(principal_id) DO UPDATE SET
         issuer = excluded.issuer, audience = excluded.audience, updated_at = excluded.updated_at`,
    ).run(input.connectionId, issuer, audience, now, now);
    appendAudit(db, {
      eventType: "host-identity-bound",
      principalId: input.connectionId,
      actorTokenId: input.actorTokenId,
      detail: { issuer, audience },
      now,
    });
    return { ok: true, value: getHostIdentityBinding(db, input.connectionId)! };
  })();
}

/** Return a connection to ordinary use, revoking every agent grant made under its host. */
export function removeHostIdentityBinding(
  db: Db,
  input: HostIdentityUnbindInput,
  now = Date.now(),
): AccessMutationResult<null> {
  return db.transaction((): AccessMutationResult<null> => {
    if (!getHostIdentityBinding(db, input.connectionId)) return { ok: false, error: "not-found" };
    revokeConnectionAgentGrants(db, input.connectionId, now);
    db.prepare("DELETE FROM access_host_identity_bindings WHERE principal_id = ?").run(
      input.connectionId,
    );
    appendAudit(db, {
      eventType: "host-identity-unbound",
      principalId: input.connectionId,
      actorTokenId: input.actorTokenId,
      now,
    });
    return { ok: true, value: null };
  })();
}

/**
 * Give one agent, acting for one person, an access level, or deny it any
 * access with `levelId: null`. Refused as `host-agent-exists` while the agent
 * already has a grant; `setHostAgentGrant` replaces one.
 */
export function createHostAgentGrant(
  db: Db,
  input: HostAgentGrantCreateInput,
  now = Date.now(),
): AccessMutationResult<HostAgentGrant> {
  return writeHostAgentGrant(db, input, false, now);
}

/**
 * Give one agent its access level, or deny it with `levelId: null`, replacing
 * the grant it has. A replaced grant is revoked and a new one made, so a call
 * already running on the old one releases nothing.
 */
export function setHostAgentGrant(
  db: Db,
  input: HostAgentGrantCreateInput,
  now = Date.now(),
): AccessMutationResult<HostAgentGrant> {
  return writeHostAgentGrant(db, input, true, now);
}

function writeHostAgentGrant(
  db: Db,
  input: HostAgentGrantCreateInput,
  replace: boolean,
  now: number,
): AccessMutationResult<HostAgentGrant> {
  const person = normalizeHostPerson(input.person);
  const agent = normalizeHostAgentGrantName(input.agent);
  if (!person || !agent) return { ok: false, error: "invalid-selection" };
  try {
    return db.transaction((): AccessMutationResult<HostAgentGrant> => {
      if (!getConnectionGrant(db, input.connectionId, now)) {
        return { ok: false, error: "not-found" };
      }
      if (!getHostIdentityBinding(db, input.connectionId)) {
        return { ok: false, error: "host-not-bound" };
      }
      if (input.levelId !== null && !getLiveLevelRow(db, input.levelId)) {
        return { ok: false, error: "inactive-grant" };
      }
      const current = replace ? findLiveAgentGrant(db, input.connectionId, person, agent) : null;
      if (current && current.levelId === input.levelId) return { ok: true, value: current };
      if (current) {
        db.prepare("UPDATE access_host_agent_grants SET revoked_at = ? WHERE id = ?").run(
          now,
          current.id,
        );
      }
      const id = randomUUID();
      db.prepare(
        `INSERT INTO access_host_agent_grants (id, principal_id, person, agent, level_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, input.connectionId, person, agent, input.levelId, now);
      appendAudit(db, {
        eventType: input.levelId === null ? "host-agent-denied" : "host-agent-granted",
        principalId: input.connectionId,
        actorTokenId: input.actorTokenId,
        detail: {
          hostAgentGrantId: id,
          person,
          agent,
          levelId: input.levelId,
          ...(current ? { replacedHostAgentGrantId: current.id } : {}),
        },
        now,
      });
      return { ok: true, value: getHostAgentGrant(db, id)! };
    })();
  } catch (error) {
    if (isUniqueConstraint(error)) return { ok: false, error: "host-agent-exists" };
    throw error;
  }
}

/**
 * Revoke one agent's grant or denial. The agent then gets the person's
 * default, so while there is one the revocation is refused as
 * `default-would-apply` unless `fallback: "default"` says that is meant. A
 * person's default is not an agent's grant and is not revoked here.
 */
export function revokeHostAgentGrant(
  db: Db,
  input: HostAgentGrantRevokeInput,
  now = Date.now(),
): AccessMutationResult<null> {
  return db.transaction((): AccessMutationResult<null> => {
    const grant = getHostAgentGrant(db, input.grantId);
    if (!grant || grant.revokedAt !== null || grant.agent === HOST_AGENT_DEFAULT) {
      return { ok: false, error: "not-found" };
    }
    const fallback = getHostAgentDefault(db, grant.connectionId, grant.person);
    if (fallback && input.fallback !== "default") {
      return { ok: false, error: "default-would-apply" };
    }
    db.prepare("UPDATE access_host_agent_grants SET revoked_at = ? WHERE id = ?").run(
      now,
      grant.id,
    );
    appendAudit(db, {
      eventType: "host-agent-revoked",
      principalId: grant.connectionId,
      actorTokenId: input.actorTokenId,
      detail: {
        hostAgentGrantId: grant.id,
        person: grant.person,
        agent: grant.agent,
        levelId: grant.levelId,
        ...(fallback ? { fallbackHostAgentGrantId: fallback.id } : {}),
      },
      now,
    });
    return { ok: true, value: null };
  })();
}

function findLiveAgentGrant(
  db: Db,
  connectionId: string,
  person: string,
  agent: string,
): HostAgentGrant | null {
  const row = db
    .prepare<[string, string, string], { id: string }>(
      `SELECT id FROM access_host_agent_grants
        WHERE principal_id = ? AND person = ? AND agent = ? AND revoked_at IS NULL`,
    )
    .get(connectionId, person, agent);
  return row ? getHostAgentGrant(db, row.id) : null;
}

/**
 * Give every agent of a bound host, acting for one person, the level it gets
 * when no grant names it, or clear that default with `levelId: null`. The
 * default is a grant row whose agent is `HOST_AGENT_DEFAULT`, so it is revoked
 * with the binding like every grant, and a changed default is a new row: a
 * call already running on the old one releases nothing.
 */
export function setHostAgentDefault(
  db: Db,
  input: HostAgentDefaultInput,
  now = Date.now(),
): AccessMutationResult<HostAgentDefault | null> {
  const person = normalizeHostPerson(input.person);
  if (!person) return { ok: false, error: "invalid-selection" };
  if (input.levelId !== null && !isHostPersonEmail(person)) {
    return { ok: false, error: "invalid-selection" };
  }
  return db.transaction((): AccessMutationResult<HostAgentDefault | null> => {
    const current = getHostAgentDefault(db, input.connectionId, person);
    if (input.levelId === null) {
      // Clearing never needs the connection live: a default left on a removed
      // connection must still be clearable.
      if (!current) return { ok: false, error: "not-found" };
      db.prepare("UPDATE access_host_agent_grants SET revoked_at = ? WHERE id = ?").run(
        now,
        current.id,
      );
      appendAudit(db, {
        eventType: "host-agent-default-cleared",
        principalId: input.connectionId,
        actorTokenId: input.actorTokenId,
        detail: { hostAgentGrantId: current.id, person, levelId: current.levelId },
        now,
      });
      return { ok: true, value: null };
    }
    if (!getConnectionGrant(db, input.connectionId, now)) return { ok: false, error: "not-found" };
    if (!getHostIdentityBinding(db, input.connectionId)) {
      return { ok: false, error: "host-not-bound" };
    }
    if (!getLiveLevelRow(db, input.levelId)) return { ok: false, error: "inactive-grant" };
    if (current?.levelId === input.levelId) return { ok: true, value: current };
    if (current) {
      db.prepare("UPDATE access_host_agent_grants SET revoked_at = ? WHERE id = ?").run(
        now,
        current.id,
      );
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO access_host_agent_grants (id, principal_id, person, agent, level_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.connectionId, person, HOST_AGENT_DEFAULT, input.levelId, now);
    appendAudit(db, {
      eventType: "host-agent-default-set",
      principalId: input.connectionId,
      actorTokenId: input.actorTokenId,
      detail: {
        hostAgentGrantId: id,
        person,
        levelId: input.levelId,
        ...(current ? { replacedHostAgentGrantId: current.id } : {}),
      },
      now,
    });
    return { ok: true, value: getHostAgentDefault(db, input.connectionId, person)! };
  })();
}

function getHostAgentDefault(
  db: Db,
  connectionId: string,
  person: string,
): HostAgentDefault | null {
  const row = db
    .prepare<[string, string, string], AgentGrantRow>(
      `SELECT h.*, l.name AS level_name
         FROM access_host_agent_grants h
         LEFT JOIN access_levels l ON l.id = h.level_id AND l.revoked_at IS NULL
        WHERE h.principal_id = ? AND h.person = ? AND h.agent = ? AND h.revoked_at IS NULL`,
    )
    .get(connectionId, person, HOST_AGENT_DEFAULT);
  return row ? agentDefaultFromRow(row) : null;
}

function getHostAgentGrant(db: Db, id: string): HostAgentGrant | null {
  if (!hasHostIdentityTables(db)) return null;
  const row = db
    .prepare<[string], AgentGrantRow>(
      `SELECT h.*, l.name AS level_name
         FROM access_host_agent_grants h
         LEFT JOIN access_levels l ON l.id = h.level_id AND l.revoked_at IS NULL
        WHERE h.id = ?`,
    )
    .get(id);
  return row ? agentGrantFromRow(row) : null;
}

function revokeConnectionAgentGrants(db: Db, connectionId: string, now: number): void {
  db.prepare(
    "UPDATE access_host_agent_grants SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL",
  ).run(now, connectionId);
}

/** One agent's live grant, with the rules of its level as they stand now. */
export interface ResolvedHostAgentGrant extends HostAgentAuthority {
  agent: string;
  capabilities: AccessGrantCapability[];
}

/** Why the agents of a call get nothing. */
export type HostAgentRefusal = "no-grant" | "denied" | "agent-name-mismatch";

export type HostAgentResolution =
  { ok: true; grants: ResolvedHostAgentGrant[] } | { ok: false; reason: HostAgentRefusal };

/**
 * The live grant of each named agent acting for one person through one
 * connection, read on every call so a revocation or a level edit applies to
 * the next one. An agent no grant names gets that person's default on this
 * connection, when there is one. A grant naming the agent always wins: a
 * denial refuses the call as `denied`, and a grant on a level that is gone
 * gives nothing. A grant naming the agent in other letter case refuses the
 * call as `agent-name-mismatch` rather than let the agent fall to the
 * default. When any agent has nothing, the call has nothing: an intersection
 * with nothing is nothing.
 */
export function resolveHostAgentGrants(
  db: Db,
  connectionId: string,
  person: string,
  agents: readonly string[],
): HostAgentResolution {
  if (!hasHostIdentityTables(db) || agents.length === 0) return { ok: false, reason: "no-grant" };
  const named = db.prepare<
    [string, string, string],
    { id: string; agent: string; level_id: string | null; revision: number | null }
  >(
    `SELECT h.id, h.agent, h.level_id, l.revision
       FROM access_host_agent_grants h
       LEFT JOIN access_levels l ON l.id = h.level_id AND l.revoked_at IS NULL
      WHERE h.principal_id = ? AND h.person = ? AND h.agent = ? COLLATE NOCASE
        AND h.revoked_at IS NULL`,
  );
  const fallback = named
    .all(connectionId, person, HOST_AGENT_DEFAULT)
    .find((row) => row.agent === HOST_AGENT_DEFAULT);
  const resolved: ResolvedHostAgentGrant[] = [];
  for (const agent of new Set(agents)) {
    if (agent === HOST_AGENT_DEFAULT) return { ok: false, reason: "no-grant" };
    const rows = named.all(connectionId, person, agent);
    const exact = rows.find((row) => row.agent === agent);
    if (rows.length > 0 && !exact) return { ok: false, reason: "agent-name-mismatch" };
    if (exact && exact.level_id === null) return { ok: false, reason: "denied" };
    const row = exact ?? fallback;
    if (!row || row.level_id === null || row.revision === null) {
      return { ok: false, reason: "no-grant" };
    }
    resolved.push({
      agent,
      grant: exact ? "exact" : "default",
      grantId: row.id,
      levelId: row.level_id,
      levelRevision: row.revision,
      capabilities: getLevelCapabilities(db, row.level_id),
    });
  }
  return { ok: true, grants: resolved };
}

/**
 * A connection that is no longer live takes its host access with it: once
 * its last grant or its principal is revoked, every host agent grant and
 * default under it is revoked and its binding dropped, as unbinding does.
 * Nothing happens while the connection still holds a live grant.
 */
export function releaseHostIdentityOfGoneConnection(
  db: Db,
  connectionId: string,
  actorTokenId: string,
  now: number,
): void {
  if (!getHostIdentityBinding(db, connectionId)) return;
  if (getConnectionGrant(db, connectionId, now)) return;
  revokeConnectionAgentGrants(db, connectionId, now);
  db.prepare("DELETE FROM access_host_identity_bindings WHERE principal_id = ?").run(connectionId);
  appendAudit(db, {
    eventType: "host-identity-unbound",
    principalId: connectionId,
    actorTokenId,
    detail: { reason: "connection-removed" },
    now,
  });
}

/**
 * Whether every grant a call relied on is still live, on the level revision it
 * read. A default holds only while it is still the agent's: a grant naming the
 * agent made while the call ran replaces it, so the call releases nothing.
 */
export function hostAgentAuthorityHolds(
  db: Db,
  connectionId: string,
  grants: readonly HostAgentAuthority[],
): boolean {
  if (!hasHostIdentityTables(db)) return false;
  if (!getHostIdentityBinding(db, connectionId)) return false;
  const exact = db.prepare<[string, string, string, string, number], { present: number }>(
    `SELECT 1 AS present
       FROM access_host_agent_grants h
       JOIN access_levels l ON l.id = h.level_id AND l.revoked_at IS NULL
      WHERE h.id = ? AND h.principal_id = ? AND h.agent = ? AND h.revoked_at IS NULL
        AND l.id = ? AND l.revision = ?`,
  );
  const fallback = db.prepare<[string, string, string, number, string], { present: number }>(
    `SELECT 1 AS present
       FROM access_host_agent_grants h
       JOIN access_levels l ON l.id = h.level_id AND l.revoked_at IS NULL
      WHERE h.id = ? AND h.principal_id = ? AND h.agent = '${HOST_AGENT_DEFAULT}'
        AND h.revoked_at IS NULL AND l.id = ? AND l.revision = ?
        AND NOT EXISTS (
          SELECT 1 FROM access_host_agent_grants e
           WHERE e.principal_id = h.principal_id AND e.person = h.person
             AND e.agent = ? COLLATE NOCASE AND e.revoked_at IS NULL
        )`,
  );
  return (
    grants.length > 0 &&
    grants.every((grant) =>
      grant.grant === "default"
        ? grant.agent !== HOST_AGENT_DEFAULT &&
          fallback.get(
            grant.grantId,
            connectionId,
            grant.levelId,
            grant.levelRevision,
            grant.agent,
          ) !== undefined
        : grant.grant === "exact" &&
          exact.get(
            grant.grantId,
            connectionId,
            grant.agent,
            grant.levelId,
            grant.levelRevision,
          ) !== undefined,
    )
  );
}

/** Whether a connection is bound to an agent host, so an unidentified call through it is refused. */
export function connectionRequiresHostIdentity(db: Db, connectionId: string): boolean {
  return getHostIdentityBinding(db, connectionId) !== null;
}
