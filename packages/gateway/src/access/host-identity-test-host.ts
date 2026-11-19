// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fictional agent host for tests: a P-256 key, the JWK Set it publishes at
 * `/.well-known/jwks.json` on a loopback port, and assertions minted the way
 * the host mints them. Signing uses `node:crypto` alone, so the verifier is
 * checked against an implementation it shares no code with.
 */
export class FictionalAgentHost {
  readonly keys: Array<{ privateKey: KeyObject; kid: string; jwk: Record<string, string> }> = [];
  jwksRequests = 0;
  private server: Server | null = null;
  private published: Array<Record<string, string>> = [];
  private origin = "";

  get issuer(): string {
    return this.origin;
  }

  async start(): Promise<void> {
    this.rotate();
    this.server = createServer((request, response) => {
      if (request.url !== "/.well-known/jwks.json") {
        response.writeHead(404).end();
        return;
      }
      this.jwksRequests += 1;
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ keys: this.published }));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** A new signing key, published beside the old ones. */
  rotate(): { kid: string } {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const exported = publicKey.export({ format: "jwk" }) as Record<string, string>;
    const jwk = { kty: "EC", crv: "P-256", x: exported.x!, y: exported.y! };
    const kid = createHash("sha256")
      .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
      .digest("base64url");
    this.keys.push({ privateKey, kid, jwk });
    this.published.push({ ...jwk, kid, use: "sig", alg: "ES256" });
    return { kid };
  }

  /** Stop publishing every key but the newest. */
  retireOldKeys(): void {
    this.published = this.published.slice(-1);
  }

  /**
   * Mint an assertion. `agents` is the calling agent first, then each agent
   * that asked it, most recent first. `overrides` replace claims or header
   * fields outright; `signWith` signs with another key under the same `kid`.
   */
  mint(input: {
    audience: string;
    person: string;
    agents: readonly string[];
    task?: string;
    issuer?: string;
    issuedAt?: number;
    lifetimeSeconds?: number;
    jti?: string;
    header?: Record<string, unknown>;
    claims?: Record<string, unknown>;
    signWith?: KeyObject;
  }): string {
    const key = this.keys.at(-1)!;
    const iat = input.issuedAt ?? Math.floor(Date.now() / 1_000);
    let act: Record<string, unknown> | undefined;
    for (const agent of [...input.agents].reverse()) {
      act = { sub: agent, ...(act ? { act } : {}) };
    }
    const header = { alg: "ES256", typ: "agent-host-identity+jwt", kid: key.kid, ...input.header };
    const claims = {
      iss: input.issuer ?? this.origin,
      sub: input.person,
      aud: input.audience,
      iat,
      exp: iat + (input.lifetimeSeconds ?? 120),
      jti: input.jti ?? randomUUID(),
      ...(act ? { act } : {}),
      ...(input.task ? { task: input.task } : {}),
      ...input.claims,
    };
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const signingInput = `${part(header)}.${part(claims)}`;
    const signature = sign("sha256", Buffer.from(signingInput), {
      key: input.signWith ?? key.privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `${signingInput}.${signature.toString("base64url")}`;
  }
}
