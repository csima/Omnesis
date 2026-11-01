// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";

/**
 * Per-call caller identity from an agent host.
 *
 * An agent host that calls this gateway through one connection on behalf of
 * many agents can attach, to each tool call, a short-lived assertion saying
 * which person the call acts for and which agent is calling — the agent as
 * `act.sub`, and any agents that asked it nested inside as their own `act`
 * (RFC 8693 §4.1). The assertion is an ES256 JWT of type
 * `agent-host-identity+jwt`, bound to this gateway's MCP URL by `aud`, valid
 * for two minutes and unique by `jti`. The host publishes its keys as a JWK
 * Set at `<iss>/.well-known/jwks.json`.
 *
 * Only an issuer the operator configured is trusted, so the key set is
 * fetched from the URL that configuration implies and nowhere else. Keys are
 * cached for five minutes and refetched when an assertion names a key the
 * cached set lacks, at most every thirty seconds. Each `jti` is accepted once
 * until its assertion expires; the cache is in memory because the gateway is
 * one process, and it is only written after the signature verifies.
 */

export const HOST_IDENTITY_HEADER = "x-agent-host-identity";
export const HOST_IDENTITY_TYPE = "agent-host-identity+jwt";
export const HOST_IDENTITY_JWKS_PATH = "/.well-known/jwks.json";

const CLOCK_TOLERANCE_SECONDS = 5;
const MAX_LIFETIME_SECONDS = 120;
const JWKS_CACHE_MS = 5 * 60_000;
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_TIMEOUT_MS = 3_000;
const MAX_ASSERTION_LENGTH = 8 * 1_024;
const MAX_ACT_DEPTH = 16;
const MAX_REPLAY_ENTRIES = 50_000;
const MAX_ISSUERS = 32;
const MAX_PERSON_LENGTH = 320;
const MAX_TASK_LENGTH = 200;
const MAX_JTI_LENGTH = 200;
const AGENT_PATTERN = /^instance:[A-Za-z0-9._-]{1,128}$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export type HostIdentityRefusal =
  | "malformed"
  | "type"
  | "signature"
  | "unknown-key"
  | "keys-unavailable"
  | "issuer"
  | "audience"
  | "expired"
  | "lifetime"
  | "replayed";

export class HostIdentityError extends Error {
  constructor(readonly reason: HostIdentityRefusal) {
    super(`The agent host identity assertion was refused: ${reason}.`);
    this.name = "HostIdentityError";
  }
}

/** What the operator trusts a bound connection's assertions to carry. */
export interface HostIdentityTrust {
  issuer: string;
  audience: string;
}

export interface VerifiedHostCaller {
  issuer: string;
  /** The person the call acts for, lower-cased. */
  person: string;
  /** The calling agent, `instance:<id>`: what the assertion proves. */
  agent: string;
  /** The agents that asked it, most recent first: the host's record, not proof. */
  delegators: string[];
  task: string | null;
  jti: string;
  expiresAt: number;
}

export interface HostIdentityVerifierDependencies {
  now(): number;
}

/**
 * An issuer the gateway may trust: an origin, `https://` or a loopback
 * `http://` for a host on the same machine. Returned in canonical form, or
 * null when the value is anything else.
 */
export function normalizeHostIssuer(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))
    return null;
  return url.origin;
}

/**
 * The URL an assertion's `aud` must name: the gateway's MCP URL as the host
 * saved it, without query, fragment or trailing slash. Null for anything else.
 */
export function normalizeHostAudience(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))
    return null;
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${path}`;
}

/**
 * A person as grants name them: the assertion's `sub`, trimmed and
 * lower-cased. Only printable ASCII is a person, and only a value NFKC leaves
 * as it is: a compatibility character such as the Kelvin sign would otherwise
 * fold onto another person's plain letter.
 */
export function normalizeHostPerson(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.normalize("NFKC") !== trimmed || !/^[\x21-\x7e]+$/u.test(trimmed)) return null;
  const person = trimmed.toLowerCase();
  if (person.length > MAX_PERSON_LENGTH) return null;
  return person;
}

export function isHostAgentName(value: string): boolean {
  return AGENT_PATTERN.test(value);
}

export class HostIdentityVerifier {
  private readonly keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  private readonly seenJtis = new Map<string, number>();

  constructor(
    private readonly dependencies: HostIdentityVerifierDependencies = { now: () => Date.now() },
  ) {}

  async verify(assertion: string, trust: HostIdentityTrust): Promise<VerifiedHostCaller> {
    if (assertion.length === 0 || assertion.length > MAX_ASSERTION_LENGTH) {
      throw new HostIdentityError("malformed");
    }
    const nowMs = this.dependencies.now();
    let payload: JWTPayload;
    let kid: unknown;
    try {
      const verified = await jwtVerify(assertion, this.keySet(trust.issuer), {
        algorithms: ["ES256"],
        typ: HOST_IDENTITY_TYPE,
        issuer: trust.issuer,
        audience: trust.audience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        maxTokenAge: MAX_LIFETIME_SECONDS,
        currentDate: new Date(nowMs),
        requiredClaims: ["sub", "act", "iat", "exp", "jti"],
      });
      payload = verified.payload;
      kid = verified.protectedHeader.kid;
    } catch (error) {
      throw new HostIdentityError(refusalFor(error));
    }
    if (typeof kid !== "string" || kid.length === 0) throw new HostIdentityError("malformed");
    const caller = callerFrom(payload, trust.issuer);
    this.recordJti(caller, Math.floor(nowMs / 1_000));
    return caller;
  }

  private keySet(issuer: string): ReturnType<typeof createRemoteJWKSet> {
    const cached = this.keySets.get(issuer);
    if (cached) return cached;
    if (this.keySets.size >= MAX_ISSUERS) {
      const oldest = this.keySets.keys().next().value as string | undefined;
      if (oldest !== undefined) this.keySets.delete(oldest);
    }
    const keySet = createRemoteJWKSet(new URL(`${issuer}${HOST_IDENTITY_JWKS_PATH}`), {
      cacheMaxAge: JWKS_CACHE_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
      timeoutDuration: JWKS_TIMEOUT_MS,
    });
    this.keySets.set(issuer, keySet);
    return keySet;
  }

  private recordJti(caller: VerifiedHostCaller, now: number): void {
    for (const [seen, until] of this.seenJtis) {
      if (until >= now) break;
      this.seenJtis.delete(seen);
    }
    const key = `${caller.issuer}\u0000${caller.jti}`;
    const seenUntil = this.seenJtis.get(key);
    if (seenUntil !== undefined && seenUntil >= now) throw new HostIdentityError("replayed");
    if (this.seenJtis.size >= MAX_REPLAY_ENTRIES) {
      const oldest = this.seenJtis.keys().next().value as string | undefined;
      if (oldest !== undefined) this.seenJtis.delete(oldest);
    }
    this.seenJtis.set(key, caller.expiresAt + CLOCK_TOLERANCE_SECONDS);
  }
}

function callerFrom(payload: JWTPayload, issuer: string): VerifiedHostCaller {
  if (typeof payload.aud !== "string") throw new HostIdentityError("audience");
  const { exp, iat, jti, sub } = payload;
  if (typeof exp !== "number" || typeof iat !== "number" || exp - iat > MAX_LIFETIME_SECONDS) {
    throw new HostIdentityError("lifetime");
  }
  if (typeof jti !== "string" || jti.length === 0 || jti.length > MAX_JTI_LENGTH) {
    throw new HostIdentityError("malformed");
  }
  const person = typeof sub === "string" ? normalizeHostPerson(sub) : null;
  if (!person) throw new HostIdentityError("malformed");
  const task = payload.task;
  if (task !== undefined && (typeof task !== "string" || task.length > MAX_TASK_LENGTH)) {
    throw new HostIdentityError("malformed");
  }
  const [agent, ...delegators] = actors(payload.act);
  return {
    issuer,
    person,
    agent: agent!,
    delegators,
    task: typeof task === "string" && task.length > 0 ? task : null,
    jti,
    expiresAt: exp,
  };
}

/** The `act` chain from the calling agent outward to the first one that asked. */
function actors(act: unknown): string[] {
  const chain: string[] = [];
  let node = act;
  while (node !== undefined) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      throw new HostIdentityError("malformed");
    }
    const { sub, act: inner } = node as { sub?: unknown; act?: unknown };
    if (typeof sub !== "string" || !AGENT_PATTERN.test(sub)) {
      throw new HostIdentityError("malformed");
    }
    chain.push(sub);
    if (chain.length > MAX_ACT_DEPTH) throw new HostIdentityError("malformed");
    node = inner;
  }
  if (chain.length === 0) throw new HostIdentityError("malformed");
  return chain;
}

function refusalFor(error: unknown): HostIdentityRefusal {
  if (error instanceof errors.JWTExpired) return "expired";
  if (error instanceof errors.JWTClaimValidationFailed) {
    switch (error.claim) {
      case "iss":
        return "issuer";
      case "aud":
        return "audience";
      case "typ":
        return "type";
      case "iat":
        return "lifetime";
      default:
        return "malformed";
    }
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) return "signature";
  if (error instanceof errors.JWKSNoMatchingKey) return "unknown-key";
  if (error instanceof errors.JWKSMultipleMatchingKeys) return "unknown-key";
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) {
    return "keys-unavailable";
  }
  if (
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JOSENotSupported
  ) {
    return "malformed";
  }
  return "keys-unavailable";
}
