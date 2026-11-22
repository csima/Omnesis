// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Build the Safari Web Extension's resources for the iPhone app.
 *
 * The output is committed under `ios/Sources/OmnesisSafariExtension/Resources`
 * so an Xcode build needs no Node toolchain; `src/safari/bundle.test.ts` fails
 * when the committed copy is not what this script produces. Run
 * `npm run build:safari -w extension` after changing anything the bundles
 * import.
 *
 * The directory is flat on purpose: Xcode copies every file into the root of
 * the extension bundle, where Safari reads `manifest.json` and resolves the
 * paths it names. Scripts are plain (non-module) bundles, which a content
 * script must be and Safari's background page can be.
 */
import { build } from "esbuild";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export const SAFARI_RESOURCES_DIR = join(
  dirname(root),
  "ios/Sources/OmnesisSafariExtension/Resources",
);

const ICON_SIZES = [16, 32, 48, 128];

export async function buildSafari(outdir = SAFARI_RESOURCES_DIR) {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  await build({
    entryPoints: {
      background: join(root, "src/safari/background-entry.ts"),
      content: join(root, "src/safari/content.ts"),
      popup: join(root, "src/safari/popup.ts"),
    },
    outdir,
    // Module paths in the output are relative to this, so the bundle is the
    // same bytes whichever directory the build was started from.
    absWorkingDir: root,
    bundle: true,
    format: "iife",
    target: "safari17",
    platform: "browser",
    charset: "utf8",
    legalComments: "none",
    sourcemap: false,
    minify: false,
    logLevel: "silent",
  });

  // esbuild labels each module with its path, and a dependency's path depends
  // on where this checkout keeps `node_modules`. Name dependencies from
  // `node_modules/` on, so every checkout produces the same bytes.
  for (const name of ["background.js", "content.js", "popup.js"]) {
    const file = join(outdir, name);
    const text = await readFile(file, "utf8");
    await writeFile(
      file,
      text
        .replace(/^(\s*\/\/ ).*\/(node_modules\/.*)$/gm, "$1$2")
        .replace(/"[^"\n]*\/(node_modules\/[^"\n]+)"(?=\(exports, module\))/g, '"$1"'),
    );
  }

  for (const name of await readdir(join(root, "public-safari"))) {
    await cp(join(root, "public-safari", name), join(outdir, name));
  }
  // The content script bundles the same third-party readers the Chrome build
  // does, so it ships the same notices.
  await cp(join(root, "public/THIRD_PARTY_NOTICES.txt"), join(outdir, "THIRD_PARTY_NOTICES.txt"));
  for (const size of ICON_SIZES) {
    await cp(join(root, "public/icons", `icon-${size}.png`), join(outdir, `icon-${size}.png`));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildSafari();
}
