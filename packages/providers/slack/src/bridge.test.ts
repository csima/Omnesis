// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { runBridge, credentialsFromBundle } from "./session.js";
/** Entirely fictional helper API, constructed at runtime; no browser/app stores are touched. */
describe("private helper subprocess contract", () => {
  it("executes directory-only discovery and a memory-only collection through reviewed helper interfaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnesis-slack-helper-"));
    try {
      await mkdir(join(root, "slacklib"));
      await writeFile(join(root, "slacklib", "__init__.py"), "");
      await writeFile(join(root, "slacklib", "common.py"), "class SlackError(Exception): pass\n");
      await writeFile(
        join(root, "slacklib", "client.py"),
        `class Client:
    def __init__(self,workspace): self.workspace=workspace
    def auth(self): return {'team_id':'TEXAMPLE','user_id':'USELF00'}
`,
      );
      await writeFile(
        join(root, "slacklib", "grab.py"),
        `from pathlib import Path
from .client import Client
def sources(home): return [('slack',Path('/fictional/Slack'),'fictional-keychain')]
def source_id(kind,root): return kind+':'+root.name
def read_slack_storage(root): return {}
def local_config(records): return {'teams':{'TEXAMPLE':{'user_id':'USELF00'}}}
def stored_user_agent(config,root): return 'Mozilla/5.0 fictional-helper'
def collect(home,overrides,selected_sources=None,allow_partial=False,ua_provider=None,client_factory=Client):
    workspace={'team_id':'TEXAMPLE','user_id':'USELF00','name':'Example Workshop','url':'https://example-workshop.slack.com/','token':'xoxc-fictional-fixture'}
    assert client_factory(workspace).auth()['user_id']=='USELF00'
    return {'sessions':[{'source':'slack:Slack','user_agent':ua_provider('slack',Path('/fictional/Slack'),{},overrides),'cookie':'fictional-cookie','workspaces':[workspace]}]}
`,
      );
      const config = { root, python: "/usr/bin/python3", sources: [], userAgents: {} };
      expect(await runBridge(config, "list")).toEqual({ sources: ["slack:Slack"] });
      const value = credentialsFromBundle(await runBridge(config, "collect"));
      expect(value.credentials).toHaveLength(1);
      expect(value.credentials[0].identity.user_id).toBe("USELF00");
      expect(value.failures).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("spawn failures return fixed messages without a raw path or credential", async () => {
    await expect(
      runBridge(
        { root: "/fictional", python: "/missing-secret-cookie-path", sources: [], userAgents: {} },
        "collect",
      ),
    ).rejects.toMatchObject({ message: expect.not.stringContaining("missing-secret-cookie-path") });
  });
});
