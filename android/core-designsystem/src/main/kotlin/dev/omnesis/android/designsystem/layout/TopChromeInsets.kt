// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.layout

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.NonRestartableComposable

/**
 * What floating chrome drawn at the top of an edge-to-edge screen (the menu button, the
 * banners, the drawer header) must clear: everything the system draws over the window's top
 * edge, not just the status bar.
 *
 * `WindowInsets.statusBars` alone misses the caption bar a window gets when it is not
 * full-screen (freeform, desktop and dual-screen windowing) and a display cutout that sits
 * outside the status bar. Under either, a status-bar-padded button stays where the system
 * bar covers it, so it can't be seen or tapped. Material's Scaffold and TopAppBar already
 * clear these (`systemBars`); this is the same rule for hand-built top chrome. Only the top
 * and horizontal edges apply: the bottom (keyboard, gesture bar) belongs to the composer and
 * other bottom-anchored content, while the sides keep the chrome clear of a landscape
 * navigation bar or a side cutout.
 */
val WindowInsets.Companion.topChrome: WindowInsets
    @Composable
    @NonRestartableComposable
    get() = safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)
