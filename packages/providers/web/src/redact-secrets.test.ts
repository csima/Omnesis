// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { REDACTED_SECRET, redactSecrets } from "./redact-secrets.js";

/**
 * Every credential below is invented and assembled at run time from a prefix
 * and filler, so no string in this file has the shape a secret scanner looks
 * for.
 */
const join = (...parts: string[]): string => parts.join("");
const FILLER = "Q7rT2mX9pL4vN8kB3cZ6wY1hJ5dF0sGa";

const SHAPED: Array<[string, string]> = [
  ["a bearer credential", join("Bearer ", FILLER.slice(0, 20), "==")],
  ["a Slack bot token", join("xo", "xb-", "1234567890-", FILLER.slice(0, 12))],
  ["a Slack app token", join("xa", "pp-1-", FILLER.slice(0, 14))],
  ["a Slack webhook", join("hooks.slack", ".com/services/", "T000/B000/", FILLER.slice(0, 16))],
  ["an sk- key", join("s", "k-", FILLER)],
  ["an sk-proj- key", join("s", "k-proj-", FILLER)],
  ["an sk-ant- key", join("s", "k-ant-api03-", FILLER)],
  ["a JWT", join("ey", "J", FILLER.slice(0, 12), ".ey", "J", FILLER.slice(4, 18), ".", FILLER)],
  ["a GitHub classic token", join("gh", "p_", FILLER, "AbCd")],
  ["a GitHub OAuth token", join("gh", "o_", FILLER, "AbCd")],
  ["a GitHub fine-grained token", join("github", "_pat_", FILLER)],
  ["an AWS access key id", join("AK", "IA", "EXAMPLE0FICTION1")],
  ["an AWS temporary key id", join("AS", "IA", "EXAMPLE0FICTION1")],
  ["an agent host token", join("ah", "k_", FILLER.slice(0, 20))],
  ["an agent host browser token", join("bx", "t_", FILLER.slice(0, 20))],
  ["a Stripe secret key", join("s", "k_", "live_", FILLER.slice(0, 16))],
  ["a Stripe restricted key", join("r", "k_", "test_", FILLER.slice(0, 16))],
  ["a Google API key", join("AI", "za", FILLER, "xyz")],
  ["a GitLab token", join("gl", "pat-", FILLER.slice(0, 22))],
  ["an Omnesis token", join("om", "n_", "oat_", FILLER)],
];

describe("redactSecrets", () => {
  it.each(SHAPED)("redacts %s in running text", (_label, secret) => {
    const text = `Before the value ${secret} and after it.`;
    const redacted = redactSecrets(text);
    expect(redacted).toBe(`Before the value ${REDACTED_SECRET} and after it.`);
    expect(redacted).not.toContain(secret);
  });

  it.each(SHAPED)("redacts %s with its characters Markdown-escaped", (_label, secret) => {
    const escaped = secret.replace(/[_*]/g, (char) => `\\${char}`);
    const redacted = redactSecrets(`Before ${escaped} after.`);
    expect(redacted).toBe(`Before ${REDACTED_SECRET} after.`);
  });

  it("redacts Markdown-escaped names in assignments and an escaped PEM armour line", () => {
    expect(redactSecrets("api\\_key = abc123def456")).toBe(`api\\_key = ${REDACTED_SECRET}`);
    const secret = `${FILLER}${FILLER.slice(0, 8)}`;
    expect(redactSecrets(`aws\\_secret\\_access\\_key: ${secret}`)).toBe(REDACTED_SECRET);
    const pem = join("\\-----BEGIN ", "PRIVATE KEY-----\n", FILLER, "\n-----END PRIVATE KEY-----");
    expect(redactSecrets(pem)).toBe(REDACTED_SECRET);
  });

  it("redacts the whole of a bearer JWT, underscores included", () => {
    const jwt = join("ey", "J", "hbGciOi_JIUzI1", ".ey", "J", "zdWIi_OiJmaWN0", ".sig_nat-ure");
    expect(redactSecrets(`Authorization: Bearer ${jwt}`)).toBe(`Authorization: ${REDACTED_SECRET}`);
  });

  it("redacts a PEM private key from armour to armour, across lines", () => {
    const pem = join(
      "-----BEGIN ",
      "RSA PRIVATE KEY-----\n",
      FILLER,
      "\n",
      FILLER,
      "\n-----END RSA PRIVATE KEY-----",
    );
    expect(redactSecrets(`## Key\n\n${pem}\n\nNext paragraph.`)).toBe(
      `## Key\n\n${REDACTED_SECRET}\n\nNext paragraph.`,
    );
  });

  it("redacts an unterminated private key to the end of the text", () => {
    const pem = join("-----BEGIN ", "PRIVATE KEY-----\n", FILLER, "\n", FILLER);
    expect(redactSecrets(`Key:\n${pem}`)).toBe(`Key:\n${REDACTED_SECRET}`);
  });

  it("redacts an AWS secret access key after its name", () => {
    const secret = `${FILLER}${FILLER.slice(0, 8)}`;
    expect(secret).toHaveLength(40);
    expect(redactSecrets(`aws_secret_access_key = ${secret}`)).toBe(REDACTED_SECRET);
    expect(redactSecrets(`AWS_SECRET_ACCESS_KEY="${secret}"`)).toBe(`${REDACTED_SECRET}"`);
  });

  it("keeps a credential's name and redacts the value assigned to it", () => {
    expect(redactSecrets("password: correct-horse-battery")).toBe(`password: ${REDACTED_SECRET}`);
    expect(redactSecrets("API_KEY=abc123def456")).toBe(`API_KEY=${REDACTED_SECRET}`);
    expect(redactSecrets("client_secret = s3cr3t-value")).toBe(
      `client_secret = ${REDACTED_SECRET}`,
    );
    expect(redactSecrets("**Password:** correct-horse")).toBe(`**Password:** ${REDACTED_SECRET}`);
    expect(redactSecrets(`Authorization: ${join("Bearer ", FILLER)}`)).toBe(
      `Authorization: ${REDACTED_SECRET}`,
    );
  });

  it("never reaches past the end of the line for an assigned value", () => {
    expect(redactSecrets("Password:\n\nChoose one you have not used before.")).toBe(
      "Password:\n\nChoose one you have not used before.",
    );
  });

  it("leaves ordinary prose, Markdown and look-alike words alone", () => {
    const prose = [
      "# Bearer authentication",
      "",
      "Bearer tokens are described in RFC 6750; the scheme name is case-insensitive.",
      "The skeleton-key approach and an sk-short label are both fine.",
      "A ghp_ prefix alone, AKIA alone and eyJ alone are not credentials.",
      "Reset your password from the account page.",
    ].join("\n");
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("is idempotent, so a page the extension redacted keeps its hash on the gateway", () => {
    const text = SHAPED.map(([, secret]) => `x ${secret} y`).join("\n") + "\npassword: hunter-two";
    const once = redactSecrets(text);
    expect(redactSecrets(once)).toBe(once);
    for (const [, secret] of SHAPED) expect(once).not.toContain(secret);
  });

  it("returns empty text unchanged", () => {
    expect(redactSecrets("")).toBe("");
  });
});
