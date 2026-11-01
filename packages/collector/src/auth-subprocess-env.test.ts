// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { buildAuthSubprocessEnv } from "./source-ws-handlers.js";

test("the auth subprocess never inherits the Cloudflare Access service token", () => {
  const env = buildAuthSubprocessEnv(
    {
      PATH: "/usr/bin",
      OMNESIS_GATEWAY_URL: "https://omnesis.example.com",
      OMNESIS_ACCESS_CLIENT_ID: "0a1b2c3d.access",
      OMNESIS_ACCESS_CLIENT_SECRET: "fictional-inline-secret",
      OMNESIS_ACCESS_CLIENT_SECRET_FILE: "/run/secrets/access",
      OMNESIS_ACCESS_GATEWAY_URL: "https://omnesis.example.com",
      OMNESIS_LOG_FILE: "/tmp/collector.log",
    },
    "/home/maya/.config/omnesis",
  );
  expect(env).toEqual({
    PATH: "/usr/bin",
    OMNESIS_GATEWAY_URL: "https://omnesis.example.com",
    OMNESIS_CONFIG_DIR: "/home/maya/.config/omnesis",
  });
});
