// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { HandoffStorage } from "../chrome/handoff-storage.js";

/** The slice of `storage.local` the Safari build reads and writes. */
export interface SafariStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  getKeys?(): Promise<string[]>;
}

/** Storage as the staged-capture helpers read it; older Safari has no `getKeys`. */
export function safariHandoffStorage(storage: SafariStorageArea): HandoffStorage {
  return {
    get: (keys) => storage.get(keys),
    set: (items) => storage.set(items),
    remove: (keys) => storage.remove(keys),
    getKeys: async () =>
      typeof storage.getKeys === "function"
        ? storage.getKeys()
        : Object.keys(await storage.get(null)),
  };
}
