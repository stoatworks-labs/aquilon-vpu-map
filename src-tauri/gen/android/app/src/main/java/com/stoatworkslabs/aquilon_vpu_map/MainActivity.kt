package com.stoatworkslabs.aquilon_vpu_map

import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    insetContentFromSystemBars()
    applyWindowBackground()
  }

  /**
   * Repaints the band behind the system bars when the theme changes.
   *
   * `uiMode` is listed in this activity's `configChanges`, so Android does
   * **not** recreate it when the user switches between light and dark — the
   * page restyles itself through `prefers-color-scheme` and the activity keeps
   * running. Without this the background read at startup stays, and the band
   * behind the status bar ends up the wrong colour for the theme actually on
   * screen.
   */
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    applyWindowBackground()
  }

  /**
   * Keeps the page out from under the status and navigation bars.
   *
   * Android draws every app edge to edge from targetSdk 35 and, from 36,
   * ignores the opt-out attribute entirely, so the window genuinely spans the
   * whole screen and something has to account for it. The obvious web fix does
   * not work: `env(safe-area-inset-*)` reports the **display cutout** on
   * Android, not the system bars, so it reads zero on a phone with no notch
   * while the status bar still sits over the first line of the page. Adding
   * `viewport-fit=cover` to make it apply *regresses iOS*, where the webview is
   * already inset correctly.
   *
   * The padding goes on the activity's content view, **not** on the WebView. A
   * WebView lays its page out against its full bounds and ignores padding, so
   * padding it changes nothing on screen and looks exactly like a listener
   * that never fired. Padding the container that holds it does move it.
   *
   * `systemBars() or displayCutout()` covers the bars on an ordinary phone and
   * the notch when a rotation moves the cutout to a side.
   */
  private fun insetContentFromSystemBars() {
    val content = findViewById<View>(android.R.id.content)

    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      val insets = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      view.setPadding(insets.left, insets.top, insets.right, insets.bottom)
      // Returned unconsumed: nothing else in this window needs them, and
      // consuming would be a lie if that ever stops being true.
      windowInsets
    }

    // The view is already attached by this point, so the initial dispatch has
    // been and gone and the listener above would otherwise never fire.
    ViewCompat.requestApplyInsets(content)
  }

  /** The bars sit over whatever is behind the content view, so it has to carry
   *  the app's own colour or the inset shows as a band in the wrong shade. */
  private fun applyWindowBackground() {
    val night =
      resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
        Configuration.UI_MODE_NIGHT_YES
    val colour = if (night) GROUND_DARK else GROUND_LIGHT
    window.setBackgroundDrawable(ColorDrawable(Color.parseColor(colour)))
  }

  private companion object {
    /** `--ground` from public/styles.css, both themes. Keep them in step. */
    const val GROUND_LIGHT = "#F2F5F5"
    const val GROUND_DARK = "#0D1416"
  }
}
