// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { createLogger, writeProviderAccountCredentials } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { SlackClient } from "./client.js";
import {
  authenticateOfficial,
  authenticateSession,
  cleanupSession,
  discoverSession,
  loadSessionManifest,
  authFailure,
  verifyOfficial,
} from "./provider.js";
import { bridge } from "./session.js";
import type { AuthSession } from "@omnesis/source-sdk";
vi.mock("@omnesis/core", async (original) => ({
  ...(await original<typeof import("@omnesis/core")>()),
  writeProviderAccountCredentials: vi.fn(),
}));
vi.mock("./session.js", async (original) => ({
  ...(await original<typeof import("./session.js")>()),
  bridge: vi.fn(),
}));
const temp: string[] = [];
async function session(accountId?: string): Promise<AuthSession> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-slack-auth-"));
  temp.push(dir);
  return {
    reason: accountId ? "reauthenticate" : "connect",
    flowId: "fictional-flow",
    accountId,
    supplied: {},
    host: {
      configDir: dir,
      stateDir: join(dir, "state"),
      log: createLogger("provider:slack:test"),
      now: () => new Date(),
    },
    canShow: () => true,
    show: async () => {},
    ask: vi.fn(),
  } as AuthSession;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(bridge).mockReset();
  vi.mocked(writeProviderAccountCredentials).mockReset();
  for (const p of temp.splice(0)) await rm(p, { recursive: true, force: true });
});
const identity = {
  team_id: "TEXAMPLE",
  user_id: "USELF00",
  team: "Example Workshop",
  url: "https://example-workshop.slack.com/",
};
const bundle = (user = "USELF00") => ({
  sessions: [
    {
      source: "slack:Slack",
      user_agent: "Mozilla/5.0 fictional-helper",
      cookie: "fictional-cookie",
      workspaces: [
        { ...identity, user_id: user, name: identity.team, token: "xoxc-fictional-fixture" },
      ],
    },
  ],
  failedSources: [],
});
describe("Slack connection boundaries", () => {
  it("delegates official token storage to the wrapped credential helper", async () => {
    const s = await session();
    Object.assign(s, { supplied: { token: "xoxp-fictional-fixture" } });
    vi.spyOn(SlackClient.prototype, "call").mockResolvedValue(identity);
    const result = await authenticateOfficial(s);
    expect(result.accounts[0].accountId).toBe("TEXAMPLE-USELF00");
    expect(writeProviderAccountCredentials).toHaveBeenCalledExactlyOnceWith(
      "slack",
      "TEXAMPLE-USELF00",
      { token: "xoxp-fictional-fixture", identity: JSON.stringify(identity) },
      s.host.configDir,
    );
    expect(JSON.stringify(result)).not.toContain("xoxp-");
  });
  it("refuses wrong-account official reauth before writing credentials", async () => {
    const s = await session("TOTHER00-UOTHER0");
    Object.assign(s, { supplied: { token: "xoxp-fictional-fixture" } });
    vi.spyOn(SlackClient.prototype, "call").mockResolvedValue(identity);
    await expect(authenticateOfficial(s)).rejects.toMatchObject({ code: "identity-mismatch" });
  });
  it("accepts an enterprise.slack.com token and refuses an unsupported host as an auth failure", async () => {
    const spy = vi
      .spyOn(SlackClient.prototype, "call")
      .mockResolvedValue({ ...identity, url: "https://example-org.enterprise.slack.com/" });
    expect((await verifyOfficial("xoxp-fictional-fixture")).identity.url).toBe(
      "https://example-org.enterprise.slack.com/",
    );
    spy.mockResolvedValue({ ...identity, url: "https://example.slack-gov.com/" });
    await expect(verifyOfficial("xoxp-fictional-fixture")).rejects.toMatchObject({
      name: "AuthFailure",
      code: "unsupported",
    });
    spy.mockRejectedValue(new SyncError("auth", "Slack sign-in expired"));
    await expect(verifyOfficial("xoxp-fictional-fixture")).rejects.toMatchObject({
      name: "AuthFailure",
      code: "credential-rejected",
    });
  });
  it("distinguishes temporary platform failure from rejected credentials", () => {
    expect(authFailure(new SyncError("network", "Safe network failure"))).toMatchObject({
      code: "unavailable",
    });
    expect(authFailure(new SyncError("auth", "Safe auth failure"))).toMatchObject({
      code: "credential-rejected",
    });
  });
  it("keeps per-account helper selection and removes only the selected account, without session secrets on disk", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const s = await session();
    vi.mocked(s.ask)
      .mockResolvedValueOnce({ root: "/fictional/helper-one", python: "/usr/bin/python3" })
      .mockResolvedValueOnce({ sources: "slack:Slack" });
    vi.mocked(bridge)
      .mockResolvedValueOnce({ sources: ["slack:Slack"] })
      .mockResolvedValueOnce(bundle());
    const spy = vi.spyOn(SlackClient.prototype, "call").mockResolvedValue(identity);
    await authenticateSession(s);
    const other = {
      ...s,
      flowId: "second-flow",
      ask: vi
        .fn()
        .mockResolvedValueOnce({ root: "/fictional/helper-two", python: "/usr/bin/python3" })
        .mockResolvedValueOnce({ sources: "" }),
    };
    vi.mocked(bridge)
      .mockResolvedValueOnce({ sources: ["chrome:Default"] })
      .mockResolvedValueOnce(bundle("UOTHER0"));
    spy.mockResolvedValue({ ...identity, user_id: "UOTHER0" });
    await authenticateSession(other);
    const ctx = { configDir: s.host.configDir };
    expect((await discoverSession(ctx)).sort()).toEqual(["TEXAMPLE-UOTHER0", "TEXAMPLE-USELF00"]);
    expect((await loadSessionManifest(ctx.configDir, "TEXAMPLE-USELF00")).config.root).toBe(
      "/fictional/helper-one",
    );
    const text = await readFile(
      join(ctx.configDir, "slack-session", "TEXAMPLE-USELF00", "connection.json"),
      "utf8",
    );
    expect(text).not.toMatch(/xoxc-|xoxd-|fictional-cookie/);
    await cleanupSession("TEXAMPLE-USELF00", ctx);
    expect(await discoverSession(ctx)).toEqual(["TEXAMPLE-UOTHER0"]);
  });
});
