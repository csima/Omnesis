// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOTES_TOKEN_KEY } from "../chrome/notes-credential.js";
import { CONFIG_KEY, PAIRING_KEY, TOKEN_KEY } from "../chrome/storage.js";
import { buildSafari, SAFARI_RESOURCES_DIR } from "../../scripts/build-safari.mjs";

/**
 * The iPhone app ships the Safari extension from a committed copy of this
 * build, so an Xcode build needs no Node toolchain. A copy that is not what
 * the sources produce would ship code nobody reviewed or tested.
 */
describe("the Safari extension bundle committed for the iPhone app", () => {
  let fresh: string;

  beforeAll(async () => {
    fresh = await mkdtemp(join(tmpdir(), "omnesis-safari-bundle-"));
    await buildSafari(fresh);
  }, 60_000);

  afterAll(async () => {
    await rm(fresh, { recursive: true, force: true });
  });

  it("is exactly what `npm run build:safari -w extension` produces", async () => {
    const built = (await readdir(fresh)).sort();
    expect((await readdir(SAFARI_RESOURCES_DIR)).sort(), "the set of files").toEqual(built);
    for (const name of built) {
      const [committed, expected] = await Promise.all([
        readFile(join(SAFARI_RESOURCES_DIR, name)),
        readFile(join(fresh, name)),
      ]);
      expect(
        committed.equals(expected),
        `${name} is stale: run \`npm run build:safari -w extension\` and commit the result`,
      ).toBe(true);
    }
  });

  it("is flat, because Xcode copies every file to the root of the extension", async () => {
    for (const entry of await readdir(fresh, { withFileTypes: true })) {
      expect(entry.isFile(), entry.name).toBe(true);
    }
  });

  it("names only files it ships in its manifest and popup", async () => {
    const shipped = new Set(await readdir(fresh));
    const manifest = JSON.parse(await readFile(join(fresh, "manifest.json"), "utf8")) as {
      background: { scripts: string[] };
      content_scripts: Array<{ js: string[] }>;
      action: { default_popup: string; default_icon: Record<string, string> };
      icons: Record<string, string>;
      permissions: string[];
    };
    const named = [
      ...manifest.background.scripts,
      ...manifest.content_scripts.flatMap((script) => script.js),
      manifest.action.default_popup,
      ...Object.values(manifest.action.default_icon),
      ...Object.values(manifest.icons),
    ];
    const popup = await readFile(join(fresh, "popup.html"), "utf8");
    for (const match of popup.matchAll(/(?:src|href)="([^"]+)"/g)) named.push(match[1] ?? "");
    for (const name of named) expect(shipped.has(name), name).toBe(true);
    expect(manifest.permissions).toContain("nativeMessaging");
  });

  it("holds no gateway credential: the app keeps it, and no script names a token key", async () => {
    const content = await readFile(join(fresh, "content.js"), "utf8");
    expect(content).toContain(PAIRING_KEY);
    for (const name of ["background.js", "content.js", "popup.js"]) {
      const script = await readFile(join(fresh, name), "utf8");
      for (const key of [TOKEN_KEY, CONFIG_KEY, NOTES_TOKEN_KEY]) {
        expect(script, `${name} names ${key}`).not.toContain(key);
      }
    }
  });
});
