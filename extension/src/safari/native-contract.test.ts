// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isAllowedNativeRequest } from "./native-contract.js";

interface Vector {
  method: string;
  path: string;
}

/** The cases the iPhone app's own check is tested against (SafariBridgeRequestTests). */
const vectors = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../ios/Tests/OmnesisTests/Fixtures/safari-bridge-requests.json",
    ),
    "utf8",
  ),
) as { allowed: Vector[]; refused: Vector[] };

describe("the requests Safari may ask the app to make", () => {
  it.each(vectors.allowed)("allows $method $path", ({ method, path }) => {
    expect(isAllowedNativeRequest(method, path)).toBe(true);
  });

  it.each(vectors.refused)("refuses $method $path", ({ method, path }) => {
    expect(isAllowedNativeRequest(method, path)).toBe(false);
  });

  it("has cases on both sides", () => {
    expect(vectors.allowed.length).toBeGreaterThan(5);
    expect(vectors.refused.length).toBeGreaterThan(20);
  });
});
