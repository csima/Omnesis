// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** The committed resources directory of the iPhone app's Safari extension. */
export const SAFARI_RESOURCES_DIR: string;

/** Build the Safari Web Extension's resources into `outdir`, replacing it. */
export function buildSafari(outdir?: string): Promise<void>;
