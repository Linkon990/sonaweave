package com.sonaweave.app;

import android.content.res.Configuration;
import android.os.Build;
import android.webkit.WebSettings;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);

        // Keep system-bar icons in sync for configuration changes handled
        // in-place (rotation, keyboard, density, and similar changes).
        boolean isDark = (newConfig.uiMode & Configuration.UI_MODE_NIGHT_MASK)
            == Configuration.UI_MODE_NIGHT_YES;
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(
            getWindow(), getWindow().getDecorView()
        );
        bars.setAppearanceLightStatusBars(!isDark);
        bars.setAppearanceLightNavigationBars(!isDark);
        syncWebViewTheme(isDark);
    }

    @Override
    public void onResume() {
        super.onResume();
        int uiMode = getResources().getConfiguration().uiMode;
        syncWebViewTheme((uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES);
    }

    private void syncWebViewTheme(boolean isDark) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || getBridge() == null || getBridge().getWebView() == null) {
            return;
        }
        // Explicitly update WebView's force-dark mode for hosts that deliver a
        // configuration update without recreating the Activity.
        getBridge().getWebView().getSettings().setForceDark(
            isDark ? WebSettings.FORCE_DARK_ON : WebSettings.FORCE_DARK_OFF
        );
    }
}
