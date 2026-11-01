// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "omnesis-access-token-"));
const configDir = join(directory, "config");
process.env.OMNESIS_CONFIG_DIR = configDir;
process.env.OMNESIS_SECRET_STORE = "file";

const { gatewayAccessTokenCommand } = await import("./gateway-access.js");
const { readGatewayAccessCredentials } = await import("@omnesis/core");

const CLIENT_ID = "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b.access";
const CLIENT_SECRET = "fictional-cli-secret-00112233445566778899aabbccddeeff";

let output: string[] = [];

beforeEach(() => {
  output = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  });
  delete process.env.OMNESIS_ACCESS_CLIENT_ID;
  delete process.env.OMNESIS_ACCESS_CLIENT_SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(configDir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function run(...rawArgs: string[]) {
  return runCommand(gatewayAccessTokenCommand, { rawArgs });
}

describe("omnesis gateway access-token", () => {
  test("set saves the token read from a file and never prints the secret", async () => {
    const secretFile = join(directory, "secret.txt");
    writeFileSync(secretFile, `${CLIENT_SECRET}\n`);
    await run("set", "--id", CLIENT_ID, "--secret-file", secretFile);

    const saved = await readGatewayAccessCredentials(configDir, {});
    expect(saved).toMatchObject({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      source: "file",
    });
    expect(output.join("\n")).toContain(CLIENT_ID);
    expect(output.join("\n")).not.toContain(CLIENT_SECRET);
  });

  test("show names the client id and where it came from, never the secret", async () => {
    const secretFile = join(directory, "secret.txt");
    writeFileSync(secretFile, CLIENT_SECRET);
    await run("set", "--id", CLIENT_ID, "--secret-file", secretFile);
    output = [];
    await run("show");
    const shown = JSON.parse(output.join("\n")) as Record<string, unknown>;
    expect(shown).toMatchObject({ configured: true, clientId: CLIENT_ID, source: "file" });
    expect(output.join("\n")).not.toContain(CLIENT_SECRET);
  });

  test("an unreadable secret file is a usage error that writes nothing", async () => {
    await expect(
      run("set", "--id", CLIENT_ID, "--secret-file", join(directory, "missing")),
    ).rejects.toThrow(/Could not read the client secret/);
    expect(existsSync(join(configDir, "gateway-access-credentials.json"))).toBe(false);
  });

  test("a secret with a space in it is refused without being quoted back", async () => {
    const secretFile = join(directory, "bad.txt");
    writeFileSync(secretFile, `${CLIENT_SECRET} extra`);
    const err = await run("set", "--id", CLIENT_ID, "--secret-file", secretFile).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("client secret");
    expect((err as Error).message).not.toContain(CLIENT_SECRET);
  });

  test("clear removes the saved token", async () => {
    const secretFile = join(directory, "secret.txt");
    writeFileSync(secretFile, CLIENT_SECRET);
    await run("set", "--id", CLIENT_ID, "--secret-file", secretFile);
    const path = join(configDir, "gateway-access-credentials.json");
    expect(readFileSync(path, "utf8")).toBeTruthy();
    await run("clear");
    expect(existsSync(path)).toBe(false);
    expect(await readGatewayAccessCredentials(configDir, {})).toBeNull();
  });
});
