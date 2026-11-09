// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { runBridge, credentialsFromBundle } from "./session.js";
async function helper(grab: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omnesis-slack-helper-"));
  roots.push(root);
  await mkdir(join(root, "slacklib"));
  await writeFile(join(root, "slacklib", "__init__.py"), "");
  await writeFile(join(root, "slacklib", "common.py"), "class SlackError(Exception): pass\n");
  await writeFile(join(root, "slacklib", "client.py"), "class Client: pass\n");
  await writeFile(join(root, "slacklib", "grab.py"), grab);
  return root;
}
const roots: string[] = [];
afterEach(async () => {
  delete process.env.OMNESIS_KEYRING_PASSPHRASE;
  delete process.env.PYTHONPATH;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
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
  it("gives the helper an allowlisted environment in isolated mode", async () => {
    process.env.OMNESIS_KEYRING_PASSPHRASE = "fictional-passphrase";
    process.env.PYTHONPATH = "/fictional/injected";
    const root = await helper(`import os,sys
from pathlib import Path
def sources(home): return [('env',Path(k),None) for k in sorted(os.environ)]+[('isolated',Path(str(sys.flags.isolated)),None)]
def source_id(kind,root): return kind+':'+root.name
`);
    const listing = (await runBridge(
      { root, python: "/usr/bin/python3", sources: [], userAgents: {} },
      "list",
    )) as { sources: string[] };
    expect(listing.sources).toContain("isolated:1");
    expect(listing.sources).toContain("env:PYTHONDONTWRITEBYTECODE");
    expect(listing.sources).not.toContain("env:OMNESIS_KEYRING_PASSPHRASE");
    expect(listing.sources).not.toContain("env:PYTHONPATH");
    const names = listing.sources.filter((s) => s.startsWith("env:")).map((s) => s.slice(4));
    for (const name of names)
      expect(name).toMatch(/^(HOME|PATH|LANG|LC_[A-Z_]+|TMPDIR|PYTHONDONTWRITEBYTECODE)$/);
  });
  it("reports an aborted collection as an abort, not a Slack failure", async () => {
    const root = await helper(`import time
def sources(home):
    time.sleep(30)
    return []
def source_id(kind,root): return kind
`);
    const ac = new AbortController();
    const pending = runBridge(
      { root, python: "/usr/bin/python3", sources: [], userAgents: {} },
      "list",
      ac.signal,
    );
    setTimeout(() => ac.abort(), 100);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
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
