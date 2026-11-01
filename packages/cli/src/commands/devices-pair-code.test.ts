// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `devices pair --ttl/--json` and `pair --code-file`: the two pieces an
 * unattended install needs — a code that lives long enough to be handed over,
 * printed as something a script can read, and redeemed without ever being on
 * a command line.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "omnesis-pair-code-"));
process.env.OMNESIS_CONFIG_DIR = join(directory, "config");

const { devicesCommand, MAX_PAIRING_TTL_MS, parsePairingTtl, readPairingCodeFile } =
  await import("./devices.js");

type Runnable = { run: (ctx: unknown) => Promise<void> };

const CODE = "35168AE493";
const DEVICE_ID = "3f6a1c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const TOKEN_ID = "7c8d9e0f-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

async function sub(name: string): Promise<Runnable & { cmd: unknown }> {
  const all = (await devicesCommand.subCommands!) as Record<string, Runnable>;
  return Object.assign(all[name]!, { cmd: all[name] });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("devices pair --ttl", () => {
  it("accepts a duration with a unit, up to two hours", () => {
    expect(parsePairingTtl("30m")).toBe(30 * 60 * 1000);
    expect(parsePairingTtl("2h")).toBe(MAX_PAIRING_TTL_MS);
    expect(parsePairingTtl("90s")).toBe(90 * 1000);
  });

  it("refuses longer than two hours, shorter than a minute, or no unit", () => {
    expect(() => parsePairingTtl("3h")).toThrow(/from 1m to 2h/);
    expect(() => parsePairingTtl("121m")).toThrow(/from 1m to 2h/);
    expect(() => parsePairingTtl("30s")).toThrow(/from 1m to 2h/);
    expect(() => parsePairingTtl("1800000")).toThrow(/not a duration/);
    expect(() => parsePairingTtl("soon")).toThrow(/not a duration/);
  });

  it("asks the gateway for that lifetime", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        Response.json({ pairingCode: CODE, scopes: ["read"], expiresAt: Date.now() + 1_800_000 }),
      );
    vi.stubGlobal("fetch", request);
    vi.stubEnv("OMNESIS_TOKEN", `omn_${"a".repeat(32)}`);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const pair = await sub("pair");
    await pair.run({ args: { kind: "collector", ttl: "30m" }, rawArgs: [], cmd: pair.cmd });
    const body = JSON.parse((request.mock.calls[0]?.[1] as { body: string }).body) as unknown;
    expect(body).toEqual({ kind: "collector", ttlMs: 30 * 60 * 1000 });
  });

  it("refuses an over-long lifetime before asking the gateway", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const pair = await sub("pair");
    await expect(
      pair.run({ args: { kind: "collector", ttl: "1d" }, rawArgs: [], cmd: pair.cmd }),
    ).rejects.toThrow(/from 1m to 2h/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("devices pair --json", () => {
  it("prints {code, expiresAt, kind} and nothing else", async () => {
    const expiresAt = Date.UTC(2026, 10, 1, 15, 30, 0);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ pairingCode: CODE, scopes: ["read"], expiresAt })),
    );
    vi.stubEnv("OMNESIS_TOKEN", `omn_${"a".repeat(32)}`);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const pair = await sub("pair");
    await pair.run({ args: { kind: "collector", json: true }, rawArgs: [], cmd: pair.cmd });
    expect(JSON.parse(lines.join("\n"))).toEqual({
      code: CODE,
      expiresAt: "2026-11-01T15:30:00.000Z",
      kind: "collector",
    });
  });
});

describe("pair --code-file", () => {
  function codeFile(name: string, mode: number, content = `${CODE}\n`): string {
    const path = join(directory, name);
    writeFileSync(path, content, { mode });
    chmodSync(path, mode);
    return path;
  }

  it("reads an owner-only file, trimmed", () => {
    expect(readPairingCodeFile(codeFile("owner", 0o600))).toBe(CODE);
  });

  it("refuses a file other users can read", () => {
    expect(() => readPairingCodeFile(codeFile("shared", 0o644))).toThrow(/open to other users/);
    expect(() => readPairingCodeFile(codeFile("group", 0o640))).toThrow(/open to other users/);
  });

  it("refuses a symlink, even to an owner-only file", () => {
    const target = codeFile("target", 0o600);
    const link = join(directory, "link");
    symlinkSync(target, link);
    expect(() => readPairingCodeFile(link)).toThrow(/ELOOP|EMLINK|not a regular file/);
  });

  it("refuses something that isn't a regular file", () => {
    const dir = join(directory, "a-directory");
    mkdirSync(dir, { mode: 0o700 });
    expect(() => readPairingCodeFile(dir)).toThrow(/not a regular file|EISDIR/);
  });

  it("refuses a missing file without quoting anything from it", () => {
    expect(() => readPairingCodeFile(join(directory, "absent"))).toThrow(/ENOENT/);
  });

  it("redeems the code it read, which no argument carried", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json({
        device: { id: DEVICE_ID, name: "field-station", kind: "collector" },
        tokenId: TOKEN_ID,
        token: `omn_${"0123456789abcdef".repeat(2)}`,
        scopes: ["read"],
      }),
    );
    vi.stubGlobal("fetch", request);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const redeem = await sub("redeem");
    await redeem.run({
      args: { "code-file": codeFile("redeem", 0o600), "gateway-url": "http://127.0.0.1:17699" },
      rawArgs: [],
      cmd: redeem.cmd,
    });
    const [url, init] = request.mock.calls.at(-1) as [string, { body: string }];
    expect(url).toBe("http://127.0.0.1:17699/devices/pair");
    expect((JSON.parse(init.body) as { pairingCode: string }).pairingCode).toBe(CODE);
  });

  it("refuses a code given both ways", async () => {
    const redeem = await sub("redeem");
    await expect(
      redeem.run({
        args: { code: CODE, "code-file": codeFile("both", 0o600) },
        rawArgs: [],
        cmd: redeem.cmd,
      }),
    ).rejects.toThrow(/not both/);
  });
});
