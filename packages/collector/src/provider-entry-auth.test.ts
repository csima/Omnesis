// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Caleb Sima

import { describe, it, expect } from "vitest";
import { defineProvider, syncPage } from "@omnesis/source-sdk";
import { extractDescriptors } from "./source-descriptors.js";

describe("provider entry connection overrides", () => {
  it("isolates sibling auth kinds, credential forms, flows and cleanup", async () => {
    const removed: string[] = [];
    const parentFlow = async () => ({
      accounts: [{ accountId: "parent", state: { status: "connected" as const } }],
    });
    const childFlow = async () => ({
      accounts: [{ accountId: "child", state: { status: "connected" as const } }],
    });
    const create = async () => ({ sync: async () => syncPage([], {}) });
    const provider = defineProvider({
      provider: { id: "example", name: "Example" },
      authType: "api-key",
      credentials: {
        fileKey: "example",
        required: true,
        wizard: { intro: "Example", why: "Example", estMinutes: 1, steps: [] },
        fields: [{ name: "token", label: "Token", secret: true }],
      },
      authenticate: parentFlow,
      cleanupCredentials: async (id) => {
        removed.push("parent:" + id);
      },
      sources: [
        { id: "example", name: "Example", description: "Default connection", create },
        {
          id: "example-local",
          name: "Example local",
          description: "Local connection",
          experimental: true,
          authType: "local",
          credentials: {
            fileKey: "example-local",
            required: false,
            wizard: { intro: "Local", why: "Local", estMinutes: 1, steps: [] },
            fields: [],
          },
          authenticate: childFlow,
          cleanupCredentials: async (id) => {
            removed.push("child:" + id);
          },
          create,
        },
      ],
    });
    const [official, local] = extractDescriptors(provider);
    expect(official.authType).toBe("api-key");
    expect(local.authType).toBe("local");
    expect(local.experimental).toBe(true);
    expect(official.experimental).toBeUndefined();
    expect(official.credentials?.fields).toHaveLength(1);
    expect(local.credentials?.fields).toHaveLength(0);
    // The callbacks close over their own entry; no source-name dispatch is involved.
    await official.cleanupCredentials!("one");
    await local.cleanupCredentials!("two");
    expect(removed).toEqual(["parent:one", "child:two"]);
  });
});
