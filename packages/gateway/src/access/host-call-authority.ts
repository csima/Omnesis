// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  getHostIdentityBinding,
  resolveHostAgentGrants,
  type ResolvedHostAgentGrant,
} from "./store-host-identity.js";
import {
  HostIdentityError,
  type HostIdentityVerifier,
  type VerifiedHostCaller,
} from "./host-identity.js";
import type { Db } from "../data/types.js";
import type { AccessCapability, AccessGrantCapability, HostCallerAudit } from "./types.js";

/**
 * What one MCP request through a connection may do once its agent host's
 * assertion is read.
 *
 * - `unbound`: an ordinary connection; its own grant applies and any
 *   assertion is ignored.
 * - `unidentified`: a bound connection called without an assertion. The
 *   host sends one only with tool calls, so the request may list tools —
 *   under the connection's own grant, which is the ceiling every agent's
 *   grant is cut from — but every tool call is refused.
 * - `authorized`: a verified caller with at least one capability left.
 * - `refused`: a bound connection whose assertion failed, or whose caller has
 *   no grant. Nothing is served.
 */
export type HostCallAuthority =
  | { kind: "unbound" }
  | { kind: "unidentified" }
  | {
      kind: "authorized";
      caller: VerifiedHostCaller;
      capabilities: AccessGrantCapability[];
      audit: HostCallerAudit;
    }
  | { kind: "refused"; reason: string };

export class HostCallAuthorizer {
  constructor(
    private readonly reader: Db,
    private readonly verifier: HostIdentityVerifier,
  ) {}

  async authorize(input: {
    connectionId: string;
    connectionCapabilities: readonly AccessGrantCapability[];
    assertion: string | undefined;
  }): Promise<HostCallAuthority> {
    const binding = getHostIdentityBinding(this.reader, input.connectionId);
    if (!binding) return { kind: "unbound" };
    if (input.assertion === undefined) return { kind: "unidentified" };
    let caller: VerifiedHostCaller;
    try {
      caller = await this.verifier.verify(input.assertion, {
        issuer: binding.issuer,
        audience: binding.audience,
      });
    } catch (error) {
      if (error instanceof HostIdentityError) return { kind: "refused", reason: error.reason };
      throw error;
    }
    const resolution = resolveHostAgentGrants(this.reader, input.connectionId, caller.person, [
      caller.agent,
      ...caller.delegators,
    ]);
    if (!resolution.ok) return { kind: "refused", reason: resolution.reason };
    const grants = resolution.grants;
    const capabilities = intersectCapabilities([
      input.connectionCapabilities,
      ...grants.map((grant) => grant.capabilities),
    ]);
    if (capabilities.length === 0) return { kind: "refused", reason: "no-grant" };
    return {
      kind: "authorized",
      caller,
      capabilities,
      audit: callerAudit(caller, grants),
    };
  }
}

function callerAudit(
  caller: VerifiedHostCaller,
  grants: readonly ResolvedHostAgentGrant[],
): HostCallerAudit {
  return {
    agent: caller.agent,
    delegators: caller.delegators,
    task: caller.task,
    grants: grants.map(({ agent, grant, grantId, levelId, levelRevision }) => ({
      agent,
      grant,
      grantId,
      levelId,
      levelRevision,
    })),
  };
}

type SourceRule = Pick<AccessGrantCapability, "sourceMode" | "sourceIds">;

/**
 * The access every one of these rule sets allows, and nothing more: a
 * capability survives only when every set holds it, over only the sources
 * every set allows. A delegate's call is cut by each agent that asked it, so
 * it never reaches further than the narrowest of them.
 *
 * Answer keeps a release mode only when the sets agree: every set unreviewed,
 * or every reviewed set naming the same policy. Two different policies have
 * no common release, so Answer is dropped rather than released under either.
 * A capability left with no source at all is dropped too.
 */
export function intersectCapabilities(
  sets: readonly (readonly AccessGrantCapability[])[],
): AccessGrantCapability[] {
  if (sets.length === 0) return [];
  const capabilities: AccessCapability[] = ["direct", "answer", "notes"];
  const result: AccessGrantCapability[] = [];
  for (const capability of capabilities) {
    const rules = sets.map((set) => set.find((rule) => rule.capability === capability));
    if (rules.some((rule) => rule === undefined)) continue;
    const present = rules as AccessGrantCapability[];
    const sources = present.slice(1).reduce<SourceRule>(intersectSources, present[0]!);
    if (sources.sourceMode === "allowlist" && sources.sourceIds.length === 0) continue;
    if (capability !== "answer") {
      result.push({
        capability,
        ...sources,
        releaseMode: null,
        policyFamilyId: null,
        policyRevision: null,
        privacyPolicy: null,
      });
      continue;
    }
    const release = commonRelease(present);
    if (release) result.push({ capability, ...sources, ...release });
  }
  return result;
}

function intersectSources(left: SourceRule, right: SourceRule): SourceRule {
  if (left.sourceMode === "all") return normalized(right.sourceMode, right.sourceIds);
  if (right.sourceMode === "all") return normalized(left.sourceMode, left.sourceIds);
  const leftIds = new Set(left.sourceIds);
  const rightIds = new Set(right.sourceIds);
  if (left.sourceMode === "allowlist" && right.sourceMode === "allowlist") {
    return normalized(
      "allowlist",
      [...leftIds].filter((id) => rightIds.has(id)),
    );
  }
  if (left.sourceMode === "allowlist") {
    return normalized(
      "allowlist",
      [...leftIds].filter((id) => !rightIds.has(id)),
    );
  }
  if (right.sourceMode === "allowlist") {
    return normalized(
      "allowlist",
      [...rightIds].filter((id) => !leftIds.has(id)),
    );
  }
  return normalized("denylist", [...leftIds, ...rightIds]);
}

function normalized(mode: SourceRule["sourceMode"], ids: readonly string[]): SourceRule {
  if (mode === "all") return { sourceMode: "all", sourceIds: [] };
  const sourceIds = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  if (mode === "denylist" && sourceIds.length === 0) return { sourceMode: "all", sourceIds: [] };
  return { sourceMode: mode, sourceIds };
}

function commonRelease(
  rules: readonly AccessGrantCapability[],
): Pick<
  AccessGrantCapability,
  "releaseMode" | "policyFamilyId" | "policyRevision" | "privacyPolicy"
> | null {
  const reviewed = rules.filter((rule) => rule.releaseMode === "reviewed");
  if (reviewed.length === 0) {
    return rules.every((rule) => rule.releaseMode === "unreviewed")
      ? {
          releaseMode: "unreviewed",
          policyFamilyId: null,
          policyRevision: null,
          privacyPolicy: null,
        }
      : null;
  }
  const [first] = reviewed;
  if (
    !first?.policyFamilyId ||
    !first.policyRevision ||
    reviewed.some(
      (rule) =>
        rule.policyFamilyId !== first.policyFamilyId ||
        rule.policyRevision !== first.policyRevision,
    )
  ) {
    return null;
  }
  return {
    releaseMode: "reviewed",
    policyFamilyId: first.policyFamilyId,
    policyRevision: first.policyRevision,
    privacyPolicy: first.privacyPolicy,
  };
}
