// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { describe, it, expect } from "vitest";
import { credentialsFromBundle } from "./session.js";
import { accountKey } from "./types.js";
const workspace = (user = "USELF00") => ({
  team_id: "TEXAMPLE",
  user_id: user,
  name: "Example Workshop",
  url: "https://example-workshop.slack.com/",
  token: "xoxc-fictional-fixture",
});
const source = (id: string, user = "USELF00") => ({
  source: id,
  user_agent: "Mozilla/5.0 fictional-source",
  cookie: "fictional-cookie",
  workspaces: [workspace(user)],
});
describe("local memory-only handoff", () => {
  it("keeps desktop precedence but preserves different users in a workspace", () => {
    const result = credentialsFromBundle({
      sessions: [
        source("chrome:Default"),
        source("slack:Slack"),
        source("chrome:Profile 1", "UOTHER0"),
      ],
      failedSources: [],
    });
    expect(result.credentials.map((c) => accountKey(c.identity))).toEqual([
      "TEXAMPLE-USELF00",
      "TEXAMPLE-UOTHER0",
    ]);
    expect(result.credentials[0].userAgent).toBe("Mozilla/5.0 fictional-source");
  });
  it.each([
    "https://evil.example/",
    "https://example.slack.com.evil.example/",
    "https://example.slack-gov.com/",
    "http://example.slack.com/",
    "https://example.slack.com:8443/",
  ])("reports unsupported workspace host %s as a failure and keeps the others", (url) => {
    const s = source("slack:Slack");
    s.workspaces[0].url = url;
    const other = source("chrome:Default", "UOTHER0");
    const result = credentialsFromBundle({ sessions: [s, other], failedSources: [] });
    expect(result.credentials.map((c) => accountKey(c.identity))).toEqual(["TEXAMPLE-UOTHER0"]);
    expect(result.failures).toEqual(["TEXAMPLE-USELF00"]);
    expect(JSON.stringify(result.credentials)).not.toContain(url);
  });
  it("accepts an enterprise.slack.com organization host", () => {
    const s = source("slack:Slack");
    s.workspaces[0].url = "https://example-org.enterprise.slack.com/";
    const result = credentialsFromBundle({ sessions: [s], failedSources: [] });
    expect(result.credentials[0].identity.url).toBe("https://example-org.enterprise.slack.com/");
    expect(result.failures).toEqual([]);
  });
  it("invalid output never includes input values in the error", () => {
    expect(() => credentialsFromBundle({ sessions: [{ cookie: "fictional-secret" }] })).toThrow(
      "invalid handoff",
    );
  });
  it("names failed sources and never turns them into a deletion snapshot", () => {
    expect(
      credentialsFromBundle({
        sessions: [source("slack:Slack")],
        failedSources: ["chrome:Profile 2"],
      }).failures,
    ).toEqual(["chrome:Profile 2"]);
  });
});
