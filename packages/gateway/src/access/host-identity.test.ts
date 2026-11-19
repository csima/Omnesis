// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HostIdentityVerifier,
  normalizeHostAudience,
  normalizeHostIssuer,
  normalizeHostPerson,
  type HostIdentityRefusal,
} from "./host-identity.js";
import { FictionalAgentHost } from "./host-identity-test-host.js";

const AUDIENCE = "https://omnesis.example.org/mcp";
const PERSON = "maya.reeves@example.com";
const RESEARCHER = "instance:researcher-1";
const PLANNER = "instance:planner-7";

let host: FictionalAgentHost;
let verifier: HostIdentityVerifier;

beforeEach(async () => {
  host = new FictionalAgentHost();
  await host.start();
  verifier = new HostIdentityVerifier();
});

afterEach(async () => {
  await host.stop();
});

function trust(overrides: Partial<{ issuer: string; audience: string }> = {}) {
  return { issuer: host.issuer, audience: AUDIENCE, ...overrides };
}

async function refusal(assertion: string, expected = trust()): Promise<HostIdentityRefusal> {
  try {
    await verifier.verify(assertion, expected);
  } catch (error) {
    return (error as { reason: HostIdentityRefusal }).reason;
  }
  throw new Error("the assertion was accepted");
}

describe("HostIdentityVerifier", () => {
  it("reads the person, the calling agent and the agents that asked it", async () => {
    const assertion = host.mint({
      audience: AUDIENCE,
      person: "Maya.Reeves@Example.com",
      agents: [RESEARCHER, PLANNER],
      task: "task-42",
    });
    const caller = await verifier.verify(assertion, trust());
    expect(caller).toMatchObject({
      issuer: host.issuer,
      person: PERSON,
      agent: RESEARCHER,
      delegators: [PLANNER],
      task: "task-42",
    });
  });

  it("refuses a signature made by another key", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const forged = host.mint({
      audience: AUDIENCE,
      person: PERSON,
      agents: [RESEARCHER],
      signWith: privateKey,
    });
    expect(await refusal(forged)).toBe("signature");
  });

  it("refuses a tampered claim", async () => {
    const [header, , signature] = host
      .mint({ audience: AUDIENCE, person: PERSON, agents: [RESEARCHER] })
      .split(".");
    const widened = Buffer.from(
      JSON.stringify({
        iss: host.issuer,
        sub: PERSON,
        aud: AUDIENCE,
        iat: Math.floor(Date.now() / 1_000),
        exp: Math.floor(Date.now() / 1_000) + 120,
        jti: "tampered",
        act: { sub: PLANNER },
      }),
    ).toString("base64url");
    expect(await refusal(`${header}.${widened}.${signature}`)).toBe("signature");
  });

  it("refuses another audience, another issuer and an audience given as a list", async () => {
    expect(
      await refusal(
        host.mint({
          audience: "https://other.example.org/mcp",
          person: PERSON,
          agents: [RESEARCHER],
        }),
      ),
    ).toBe("audience");
    expect(
      await refusal(
        host.mint({
          audience: AUDIENCE,
          person: PERSON,
          agents: [RESEARCHER],
          issuer: "https://agents.example.org",
        }),
      ),
    ).toBe("issuer");
    expect(
      await refusal(
        host.mint({
          audience: AUDIENCE,
          person: PERSON,
          agents: [RESEARCHER],
          claims: { aud: [AUDIENCE] },
        }),
      ),
    ).toBe("audience");
  });

  it("refuses an expired assertion but allows a few seconds of skew", async () => {
    const now = Math.floor(Date.now() / 1_000);
    expect(
      await refusal(
        host.mint({
          audience: AUDIENCE,
          person: PERSON,
          agents: [RESEARCHER],
          issuedAt: now - 130,
        }),
      ),
    ).toBe("expired");
    await expect(
      verifier.verify(
        host.mint({
          audience: AUDIENCE,
          person: PERSON,
          agents: [RESEARCHER],
          issuedAt: now - 122,
        }),
        trust(),
      ),
    ).resolves.toMatchObject({ agent: RESEARCHER });
    await expect(
      verifier.verify(
        host.mint({ audience: AUDIENCE, person: PERSON, agents: [RESEARCHER], issuedAt: now + 3 }),
        trust(),
      ),
    ).resolves.toMatchObject({ agent: RESEARCHER });
  });

  it("refuses an assertion that lives longer than two minutes", async () => {
    expect(
      await refusal(
        host.mint({
          audience: AUDIENCE,
          person: PERSON,
          agents: [RESEARCHER],
          lifetimeSeconds: 600,
        }),
      ),
    ).toBe("lifetime");
  });

  it("accepts each jti once", async () => {
    const assertion = host.mint({ audience: AUDIENCE, person: PERSON, agents: [RESEARCHER] });
    await verifier.verify(assertion, trust());
    expect(await refusal(assertion)).toBe("replayed");
    const sameJti = host.mint({
      audience: AUDIENCE,
      person: PERSON,
      agents: [PLANNER],
      jti: JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString()).jti,
    });
    expect(await refusal(sameJti)).toBe("replayed");
  });

  it("refuses the wrong type, an unsigned or symmetric algorithm, and a missing key id", async () => {
    expect(
      await refusal(
        host.mint({
          audience: AUDIENCE,
          person: PERSON,
          agents: [RESEARCHER],
          header: { typ: "JWT" },
        }),
      ),
    ).toBe("type");
    expect(
      await refusal(
        host.mint({
          audience: AUDIENCE,
          person: PERSON,
          agents: [RESEARCHER],
          header: { alg: "HS256" },
        }),
      ),
    ).toBe("malformed");
    const unsigned = host
      .mint({ audience: AUDIENCE, person: PERSON, agents: [RESEARCHER], header: { alg: "none" } })
      .split(".")
      .slice(0, 2)
      .join(".");
    expect(await refusal(`${unsigned}.`)).toBe("malformed");
    expect(
      await refusal(
        host.mint({
          audience: AUDIENCE,
          person: PERSON,
          agents: [RESEARCHER],
          header: { kid: undefined },
        }),
      ),
    ).toBe("malformed");
  });

  it("refuses an assertion without an agent or with a malformed one", async () => {
    expect(await refusal(host.mint({ audience: AUDIENCE, person: PERSON, agents: [] }))).toBe(
      "malformed",
    );
    expect(
      await refusal(
        host.mint({ audience: AUDIENCE, person: PERSON, agents: ["agent:researcher"] }),
      ),
    ).toBe("malformed");
    expect(
      await refusal(
        host.mint({
          audience: AUDIENCE,
          person: PERSON,
          agents: [RESEARCHER],
          claims: { act: { sub: RESEARCHER, act: "instance:planner-7" } },
        }),
      ),
    ).toBe("malformed");
    expect(
      await refusal(host.mint({ audience: AUDIENCE, person: " ", agents: [RESEARCHER] })),
    ).toBe("malformed");
  });

  it("refuses an agent at any depth that is not named as the host mints it", async () => {
    for (const name of [
      "instance:Researcher-1",
      "INSTANCE:researcher-1",
      "instance:researcher_1",
      "instance:researcher.1",
      "instance:1-researcher",
      "instance:r",
      `instance:r${"e".repeat(41)}`,
    ]) {
      for (const agents of [[name], [RESEARCHER, name], [RESEARCHER, PLANNER, name]]) {
        expect(await refusal(host.mint({ audience: AUDIENCE, person: PERSON, agents }))).toBe(
          "malformed",
        );
      }
    }
    const longest = `instance:r${"e".repeat(40)}`;
    await expect(
      verifier.verify(
        host.mint({ audience: AUDIENCE, person: PERSON, agents: [longest, PLANNER] }),
        trust(),
      ),
    ).resolves.toMatchObject({ agent: longest, delegators: [PLANNER] });
  });

  it("refuses a key the host does not publish and caches the key set", async () => {
    await verifier.verify(
      host.mint({ audience: AUDIENCE, person: PERSON, agents: [RESEARCHER] }),
      trust(),
    );
    await verifier.verify(
      host.mint({ audience: AUDIENCE, person: PERSON, agents: [RESEARCHER] }),
      trust(),
    );
    expect(host.jwksRequests).toBe(1);
    const forged = host.mint({
      audience: AUDIENCE,
      person: PERSON,
      agents: [RESEARCHER],
      header: { kid: "not-a-published-key" },
    });
    expect(await refusal(forged)).toBe("unknown-key");
  });

  it("refetches the key set for a rotated key, at most every thirty seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await verifier.verify(
        host.mint({ audience: AUDIENCE, person: PERSON, agents: [RESEARCHER] }),
        trust(),
      );
      host.rotate();
      host.retireOldKeys();
      expect(
        await refusal(host.mint({ audience: AUDIENCE, person: PERSON, agents: [RESEARCHER] })),
      ).toBe("unknown-key");
      vi.setSystemTime(Date.now() + 31_000);
      await expect(
        verifier.verify(
          host.mint({ audience: AUDIENCE, person: PERSON, agents: [RESEARCHER] }),
          trust(),
        ),
      ).resolves.toMatchObject({ agent: RESEARCHER });
      expect(host.jwksRequests).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an unreachable key set", async () => {
    const assertion = host.mint({ audience: AUDIENCE, person: PERSON, agents: [RESEARCHER] });
    const issuer = host.issuer;
    await host.stop();
    expect(await refusal(assertion, trust({ issuer }))).toBe("keys-unavailable");
  });
});

describe("host identity persons", () => {
  it("refuses a person NFKC would change or that is not plain ASCII", async () => {
    for (const sub of [
      "\u212Aate.reeves@example.com",
      "ｍaya.reeves@example.com",
      "maya.rée@example.com",
      "maya reeves@example.com",
    ]) {
      expect(normalizeHostPerson(sub)).toBeNull();
      expect(
        await refusal(host.mint({ audience: AUDIENCE, person: sub, agents: [RESEARCHER] })),
      ).toBe("malformed");
    }
    expect(normalizeHostPerson(" Kate.Reeves@Example.com ")).toBe("kate.reeves@example.com");
  });
});

describe("host identity configuration", () => {
  it("accepts an https origin or a loopback http origin as the issuer", () => {
    expect(normalizeHostIssuer("https://agents.example.org")).toBe("https://agents.example.org");
    expect(normalizeHostIssuer("https://agents.example.org/")).toBe("https://agents.example.org");
    expect(normalizeHostIssuer("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizeHostIssuer("http://agents.example.org")).toBeNull();
    expect(normalizeHostIssuer("https://agents.example.org/tenant")).toBeNull();
    expect(normalizeHostIssuer("https://agents.example.org/?x=1")).toBeNull();
    expect(normalizeHostIssuer("not a url")).toBeNull();
  });

  it("saves the audience as the host does: no query, fragment or trailing slash", () => {
    expect(normalizeHostAudience("https://omnesis.example.org/mcp/")).toBe(AUDIENCE);
    expect(normalizeHostAudience(AUDIENCE)).toBe(AUDIENCE);
    expect(normalizeHostAudience("https://omnesis.example.org/mcp?k=1")).toBeNull();
    expect(normalizeHostAudience("http://omnesis.example.org/mcp")).toBeNull();
  });
});
