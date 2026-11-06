// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { spawn } from "node:child_process";
import { z } from "zod";
import { SyncError } from "@omnesis/types";
import { accountKey, idSchema, workspaceUrl } from "./types.js";
import type { Credential } from "./types.js";

/** Glue only: store discovery, parsing, size caps, decryption and Keychain stay in reviewed slacklib. */
export const BRIDGE_PROGRAM = String.raw`
import sys,json,resource,contextlib,io
from pathlib import Path
resource.setrlimit(resource.RLIMIT_CORE,(0,0))
request=json.loads(sys.stdin.buffer.read(16385))
sys.path.insert(0,request['root'])
from slacklib import grab
from slacklib.common import SlackError
from slacklib.client import Client

def ua(kind,root,config,overrides):
    value=overrides.get(kind) or grab.stored_user_agent(config,root)
    if not value: raise SlackError('Exact source User-Agent required')
    return value

found=grab.sources(Path.home())
if request['operation']=='list':
    print(json.dumps({'sources':[grab.source_id(k,r) for k,r,_ in found]}))
else:
    selected=request.get('sources',[])
    result=[]; failures=[]
    # Per-source collection preserves different signed-in users in the same workspace.
    for item in found:
        key=grab.source_id(item[0],item[1])
        if selected and key not in selected: continue
        try:
            config=grab.local_config(grab.read_slack_storage(item[1]))
            expected={k:v.get('user_id') for k,v in config['teams'].items() if isinstance(v,dict)}
            def factory(workspace):
                client=Client(workspace)
                class Checked:
                    def auth(self):
                        result=client.auth()
                        user=expected.get(workspace['team_id'])
                        if not user or result.get('user_id')!=user:
                            raise SlackError('Stored user identity missing or inconsistent')
                        return result
                return Checked()
            with contextlib.redirect_stderr(io.StringIO()):
                bundle=grab.collect(Path.home(),request.get('userAgents',{}),selected_sources=[item],allow_partial=True,ua_provider=ua,client_factory=factory)
            result.extend(bundle['sessions'])
        except Exception:
            failures.append(key)
    print(json.dumps({'sessions':result,'failedSources':failures}))
`;
const bundleSchema = z.object({
  sessions: z.array(
    z.object({
      source: z.string().max(200),
      user_agent: z
        .string()
        .min(1)
        .max(2048)
        .regex(/^[^\r\n]+$/),
      cookie: z
        .string()
        .min(1)
        .max(8192)
        .regex(/^[^;\r\n]+$/),
      workspaces: z.array(
        z.object({
          team_id: idSchema,
          user_id: idSchema,
          name: z.string().max(500),
          url: z.string(),
          token: z
            .string()
            .regex(/^xoxc-[^\s]+$/)
            .max(8192),
        }),
      ),
    }),
  ),
  failedSources: z.array(z.string().max(200)),
});
export interface SessionConfig {
  root: string;
  python: string;
  sources: string[];
  userAgents: { slack?: string; chrome?: string };
}
export async function bridge(
  config: SessionConfig,
  operation: "list" | "collect",
  signal?: AbortSignal,
): Promise<unknown> {
  if (process.platform !== "darwin")
    throw new SyncError(
      "permission",
      "Slack session collection requires the signed-in collector Mac",
    );
  return runBridge(config, operation, signal);
}
/** Separate transport seam lets tests prove pipe bounds and secret-free failures on any OS. */
export async function runBridge(
  config: SessionConfig,
  operation: "list" | "collect",
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, ["-B", "-c", BRIDGE_PROGRAM], {
      stdio: ["pipe", "pipe", "ignore"],
      signal,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    let chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = (): void => {
      if (failed) return;
      failed = true;
      chunks = [];
      child.kill();
      reject(
        new SyncError(
          "transient",
          "Local Slack handoff unavailable; sign in again, check helper dependencies and the exact source User-Agent",
        ),
      );
    };
    const timer = setTimeout(fail, 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) fail();
      else chunks.push(chunk);
    });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) {
        fail();
        return;
      }
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        chunks = [];
        resolve(value);
      } catch {
        fail();
      }
    });
    child.stdin.end(
      JSON.stringify({
        root: config.root,
        operation,
        sources: config.sources,
        userAgents: config.userAgents,
      }),
    );
  });
}
export function credentialsFromBundle(value: unknown): {
  credentials: Credential[];
  failures: string[];
} {
  const parsed = bundleSchema.safeParse(value);
  if (!parsed.success)
    throw new SyncError(
      "auth",
      "Local Slack helper returned an invalid handoff; no session retained",
    );
  const selected = new Map<string, Credential>();
  // Reviewed helper enumerates desktop first. Sorting maintains it when a synthetic caller doesn't.
  for (const source of [...parsed.data.sessions].sort(
    (a, b) => Number(a.source.startsWith("chrome")) - Number(b.source.startsWith("chrome")),
  ))
    for (const team of source.workspaces) {
      const key = accountKey(team);
      if (selected.has(key)) continue;
      let url: string;
      try {
        url = workspaceUrl(team.url);
      } catch {
        throw new SyncError("auth", "Local Slack helper returned an invalid workspace host");
      }
      selected.set(key, {
        token: team.token,
        cookie: source.cookie,
        userAgent: source.user_agent,
        identity: { team_id: team.team_id, user_id: team.user_id, team: team.name, url },
      });
    }
  return { credentials: [...selected.values()], failures: parsed.data.failedSources };
}
