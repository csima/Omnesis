// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";

import {
  isHostAgentName,
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
  HostAgentGrant,
  HostAgentGrantCreateInput,
  HostAgentGrantRevokeInput,
  HostIdentityBinding,
  HostIdentityBindingInput,
  HostIdentityOverview,
  HostIdentityUnbindInput,
} from "./types.js";

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
  level_id: string;
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

/** Every bound connection and its live host agent grants. */
export function listHostIdentity(db: Db): HostIdentityOverview {
  if (!hasHostIdentityTables(db)) return { bindings: [] };
  const bindings = db
    .prepare<[], BindingRow>(
      "SELECT * FROM access_host_identity_bindings ORDER BY created_at, principal_id",
    )
    .all();
  const agents = db.prepare<[string], AgentGrantRow>(
    `SELECT h.*, l.name AS level_name
       FROM access_host_agent_grants h
       LEFT JOIN access_levels l ON l.id = h.level_id AND l.revoked_at IS NULL
      WHERE h.principal_id = ? AND h.revoked_at IS NULL
      ORDER BY h.person, h.agent`,
  );
  return {
    bindings: bindings.map((row) => ({
      ...bindingFromRow(row),
      agents: agents.all(row.principal_id).map(agentGrantFromRow),
    })),
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

export function createHostAgentGrant(
  db: Db,
  input: HostAgentGrantCreateInput,
  now = Date.now(),
): AccessMutationResult<HostAgentGrant> {
  const person = normalizeHostPerson(input.person);
  const agent = input.agent.trim();
  if (!person || !isHostAgentName(agent)) return { ok: false, error: "invalid-selection" };
  try {
    return db.transaction((): AccessMutationResult<HostAgentGrant> => {
      if (!getConnectionGrant(db, input.connectionId, now)) {
        return { ok: false, error: "not-found" };
      }
      if (!getHostIdentityBinding(db, input.connectionId)) {
        return { ok: false, error: "host-not-bound" };
      }
      if (!getLiveLevelRow(db, input.levelId)) return { ok: false, error: "inactive-grant" };
      const id = randomUUID();
      db.prepare(
        `INSERT INTO access_host_agent_grants (id, principal_id, person, agent, level_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, input.connectionId, person, agent, input.levelId, now);
      appendAudit(db, {
        eventType: "host-agent-granted",
        principalId: input.connectionId,
        actorTokenId: input.actorTokenId,
        detail: { hostAgentGrantId: id, agent, levelId: input.levelId },
        now,
      });
      return { ok: true, value: getHostAgentGrant(db, id)! };
    })();
  } catch (error) {
    if (isUniqueConstraint(error)) return { ok: false, error: "host-agent-exists" };
    throw error;
  }
}

export function revokeHostAgentGrant(
  db: Db,
  input: HostAgentGrantRevokeInput,
  now = Date.now(),
): AccessMutationResult<null> {
  return db.transaction((): AccessMutationResult<null> => {
    const grant = getHostAgentGrant(db, input.grantId);
    if (!grant || grant.revokedAt !== null) return { ok: false, error: "not-found" };
    db.prepare("UPDATE access_host_agent_grants SET revoked_at = ? WHERE id = ?").run(
      now,
      grant.id,
    );
    appendAudit(db, {
      eventType: "host-agent-revoked",
      principalId: grant.connectionId,
      actorTokenId: input.actorTokenId,
      detail: { hostAgentGrantId: grant.id, agent: grant.agent, levelId: grant.levelId },
      now,
    });
    return { ok: true, value: null };
  })();
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

/**
 * The live grant of each named agent acting for one person through one
 * connection, read on every call so a revocation or a level edit applies to
 * the next one. Null when any of the agents has none: an agent nobody granted
 * contributes nothing, and an intersection with nothing is nothing.
 */
export function resolveHostAgentGrants(
  db: Db,
  connectionId: string,
  person: string,
  agents: readonly string[],
): ResolvedHostAgentGrant[] | null {
  if (!hasHostIdentityTables(db) || agents.length === 0) return null;
  const find = db.prepare<
    [string, string, string],
    { id: string; level_id: string; revision: number }
  >(
    `SELECT h.id, h.level_id, l.revision
       FROM access_host_agent_grants h
       JOIN access_levels l ON l.id = h.level_id AND l.revoked_at IS NULL
      WHERE h.principal_id = ? AND h.person = ? AND h.agent = ? AND h.revoked_at IS NULL`,
  );
  const resolved: ResolvedHostAgentGrant[] = [];
  for (const agent of new Set(agents)) {
    const row = find.get(connectionId, person, agent);
    if (!row) return null;
    resolved.push({
      agent,
      grantId: row.id,
      levelId: row.level_id,
      levelRevision: row.revision,
      capabilities: getLevelCapabilities(db, row.level_id),
    });
  }
  return resolved;
}

/** Whether every grant a call relied on is still live, on the level revision it read. */
export function hostAgentAuthorityHolds(
  db: Db,
  connectionId: string,
  grants: readonly HostAgentAuthority[],
): boolean {
  if (!hasHostIdentityTables(db)) return false;
  if (!getHostIdentityBinding(db, connectionId)) return false;
  const live = db.prepare<[string, string, string, number], { present: number }>(
    `SELECT 1 AS present
       FROM access_host_agent_grants h
       JOIN access_levels l ON l.id = h.level_id AND l.revoked_at IS NULL
      WHERE h.id = ? AND h.principal_id = ? AND h.revoked_at IS NULL
        AND l.id = ? AND l.revision = ?`,
  );
  return (
    grants.length > 0 &&
    grants.every(
      (grant) =>
        live.get(grant.grantId, connectionId, grant.levelId, grant.levelRevision) !== undefined,
    )
  );
}

/** Whether a connection is bound to an agent host, so an unidentified call through it is refused. */
export function connectionRequiresHostIdentity(db: Db, connectionId: string): boolean {
  return getHostIdentityBinding(db, connectionId) !== null;
}
