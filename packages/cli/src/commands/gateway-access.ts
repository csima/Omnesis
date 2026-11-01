// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis gateway access-token` — the Cloudflare Access service token this
 * machine reaches its gateway with, when the gateway sits behind Cloudflare
 * Access. The secret is read from a file or stdin, never from the command
 * line, saved like the device token beside it, and never printed back.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import {
  DEFAULT_CONFIG_DIR,
  GatewayAccessConfigError,
  parseGatewayAccessCredentials,
  readGatewayAccessCredentials,
  removeGatewayAccessCredentials,
  writeGatewayAccessCredentials,
} from "@omnesis/core";
import { c, CliError, EXIT_FAILURE, EXIT_USER_ERROR, expandHomePath, isJSON } from "../utils.js";

function configDir(): string {
  return process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
}

function readSecretSource(source: string): string {
  if (source === "-") {
    try {
      return readFileSync(0, "utf8");
    } catch {
      throw new CliError(
        `${c.red}Could not read the client secret from stdin.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
  }
  const path = expandHomePath(source);
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unreadable";
    throw new CliError(
      `${c.red}Could not read the client secret from ${path} (${code}).${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
}

function restartHint(dir: string): string | null {
  return existsSync(join(dir, "collector-token"))
    ? "Restart the collector to use it: omnesis service restart collector"
    : null;
}

const setCommand = defineCommand({
  meta: {
    name: "set",
    description: "Save the Cloudflare Access service token this machine reaches the gateway with",
  },
  args: {
    id: {
      type: "string",
      description: "The service token's client id (CF-Access-Client-Id)",
      required: true,
    },
    "secret-file": {
      type: "string",
      description: "A file holding the client secret (CF-Access-Client-Secret), or - for stdin",
      required: true,
    },
  },
  async run(ctx) {
    const id = typeof ctx.args.id === "string" ? ctx.args.id : "";
    const source = typeof ctx.args["secret-file"] === "string" ? ctx.args["secret-file"] : "";
    if (!source) {
      throw new CliError(
        `${c.red}--secret-file names the file holding the client secret, or - for stdin.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    let credentials;
    try {
      credentials = parseGatewayAccessCredentials(id, readSecretSource(source));
    } catch (err) {
      if (err instanceof GatewayAccessConfigError) {
        throw new CliError(`${c.red}${err.message}${c.reset}`, EXIT_USER_ERROR);
      }
      throw err;
    }
    const dir = configDir();
    let saved: { path: string; encrypted: boolean };
    try {
      saved = await writeGatewayAccessCredentials(dir, credentials);
    } catch (err) {
      throw new CliError(
        `${c.red}Could not save the service token: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
        EXIT_FAILURE,
      );
    }
    if (isJSON) {
      console.log(
        JSON.stringify({ saved: true, clientId: credentials.clientId, ...saved }, null, 2),
      );
      return;
    }
    console.log(
      `Saved Cloudflare Access service token ${c.bold}${credentials.clientId}${c.reset} to ${saved.path}` +
        (saved.encrypted ? " (sealed with this install's root key)." : " (mode 0600)."),
    );
    const hint = restartHint(dir);
    if (hint) console.log(`${c.dim}${hint}${c.reset}`);
  },
});

const showCommand = defineCommand({
  meta: {
    name: "show",
    description: "Show which Cloudflare Access service token this machine sends (never the secret)",
  },
  args: {
    json: { type: "boolean", description: "Machine-readable output" },
  },
  async run() {
    let loaded;
    try {
      loaded = await readGatewayAccessCredentials(configDir());
    } catch (err) {
      throw new CliError(
        `${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`,
        EXIT_FAILURE,
      );
    }
    const status = loaded
      ? {
          configured: true,
          clientId: loaded.clientId,
          source: loaded.source,
          ...(loaded.path ? { path: loaded.path } : {}),
        }
      : { configured: false };
    if (isJSON) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    if (!loaded) {
      console.log("No Cloudflare Access service token is configured on this machine.");
      return;
    }
    console.log(
      `Cloudflare Access service token ${c.bold}${loaded.clientId}${c.reset}, from ` +
        (loaded.source === "env" ? "the environment" : loaded.path) +
        ".",
    );
  },
});

const clearCommand = defineCommand({
  meta: {
    name: "clear",
    description: "Remove the saved Cloudflare Access service token",
  },
  run() {
    const dir = configDir();
    const removed = removeGatewayAccessCredentials(dir);
    if (isJSON) {
      console.log(JSON.stringify({ removed }, null, 2));
      return;
    }
    console.log(
      removed
        ? "Removed the saved Cloudflare Access service token."
        : "No Cloudflare Access service token was saved on this machine.",
    );
    if (removed) {
      const hint = restartHint(dir);
      if (hint) console.log(`${c.dim}${hint}${c.reset}`);
    }
  },
});

export const gatewayAccessTokenCommand = defineCommand({
  meta: {
    name: "access-token",
    description: "The Cloudflare Access service token for a gateway behind Cloudflare Access",
  },
  subCommands: {
    set: setCommand,
    show: showCommand,
    clear: clearCommand,
  },
});
