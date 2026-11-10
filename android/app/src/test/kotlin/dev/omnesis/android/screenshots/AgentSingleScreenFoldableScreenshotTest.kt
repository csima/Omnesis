// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import android.view.View
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.ui.agent.AgentContent
import dev.omnesis.android.ui.agent.AgentCoordinator
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Ask landing on one screen of a dual-screen foldable (Surface Duo folded: 1350x1800 px at
 * 401 dpi, about 540x720 dp). The menu button is the only way off this screen, so every case
 * asserts it is on screen and clear of whatever the system draws over the window's top edge,
 * then records the frame.
 *
 * The captioned-window cases are the regression: a window that is not full-screen gets a
 * caption bar over its top and no status-bar inset, and the button used to sit under it,
 * unreachable, because the top chrome cleared only `statusBars`.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w540dp-h720dp-port-401dpi")
class AgentSingleScreenFoldableScreenshotTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun landingLight() = captureLanding("agent_landing_single_screen_light", dark = false)

    @Test
    fun landingDark() = captureLanding("agent_landing_single_screen_dark", dark = true)

    @Test
    fun landingKeyboardLight() =
        captureLanding("agent_landing_single_screen_ime_light", dark = false, keyboard = KeyboardHeight)

    @Test
    fun landingKeyboardDark() =
        captureLanding("agent_landing_single_screen_ime_dark", dark = true, keyboard = KeyboardHeight)

    @Test
    fun landingCaptionedWindowLight() =
        captureLanding("agent_landing_single_screen_caption_light", dark = false, top = TopBar.Caption)

    @Test
    fun landingCaptionedWindowDark() =
        captureLanding("agent_landing_single_screen_caption_dark", dark = true, top = TopBar.Caption)

    @Test
    fun landingCaptionedWindowKeyboard() = captureLanding(
        "agent_landing_single_screen_caption_ime_light",
        dark = false,
        top = TopBar.Caption,
        keyboard = KeyboardHeight,
    )

    /** What the system draws over the top of the window, and the inset type it reports. */
    private enum class TopBar(val height: Dp, val type: Int) {
        StatusBar(24.dp, WindowInsetsCompat.Type.statusBars()),
        Caption(40.dp, WindowInsetsCompat.Type.captionBar()),
    }

    private fun captureLanding(
        name: String,
        dark: Boolean,
        top: TopBar = TopBar.StatusBar,
        keyboard: Dp = 0.dp,
    ) {
        lateinit var composeView: View
        var density = 1f
        compose.setContent {
            composeView = LocalView.current
            density = LocalDensity.current.density
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    Box(Modifier.fillMaxSize()) {
                        AgentContent(
                            state = AgentCoordinator.UiState(hasClient = true),
                            catalog = SourceCatalog(),
                            onOpenMenu = {},
                            onSend = { _, _ -> },
                            onStop = {},
                            onRetry = {},
                            onNewConversation = {},
                            onFlushEphemeral = {},
                            onOpenDocument = {},
                        )
                        // Stand-ins for the system's own surfaces, which the app never draws:
                        // they make an overlap visible in the recorded frame.
                        if (top == TopBar.Caption) {
                            Box(
                                Modifier
                                    .align(Alignment.TopCenter)
                                    .fillMaxWidth()
                                    .height(top.height)
                                    .background(Color.Black.copy(alpha = 0.55f)),
                            )
                        }
                        if (keyboard > 0.dp) {
                            Box(
                                Modifier
                                    .align(Alignment.BottomCenter)
                                    .fillMaxWidth()
                                    .height(keyboard)
                                    .background(MaterialTheme.colorScheme.surfaceContainerHighest),
                            )
                        }
                    }
                }
            }
        }

        compose.runOnUiThread {
            val insets = WindowInsetsCompat.Builder()
                .setInsets(top.type, Insets.of(0, (top.height.value * density).toInt(), 0, 0))
                .setInsets(
                    WindowInsetsCompat.Type.navigationBars(),
                    Insets.of(0, 0, 0, (NavigationBarHeight.value * density).toInt()),
                )
            if (keyboard > 0.dp) {
                insets
                    .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, (keyboard.value * density).toInt()))
                    .setVisible(WindowInsetsCompat.Type.ime(), true)
            }
            ViewCompat.dispatchApplyWindowInsets(composeView, insets.build())
        }
        compose.waitForIdle()

        val menu = compose.onNodeWithTag("menu.toggle").assertIsDisplayed()
        val bounds = menu.getUnclippedBoundsInRoot()
        val root = compose.onRoot().getUnclippedBoundsInRoot()
        assertTrue(
            "menu button top ${bounds.top} must clear the ${top.name} (${top.height})",
            bounds.top >= top.height,
        )
        assertTrue(
            "menu button ${bounds} must sit inside the window $root",
            bounds.left >= root.left && bounds.right <= root.right && bounds.bottom <= root.bottom,
        )

        compose.onRoot().captureRoboImage("src/test/roborazzi/$name.png")
    }

    private companion object {
        val NavigationBarHeight = 24.dp

        // A phone keyboard takes a little over half of a 720-dp-tall screen.
        val KeyboardHeight = 380.dp
    }
}
