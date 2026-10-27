package com.kyratin.voixex;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoixexCallPlugin.class);
        registerPlugin(VoixexScreenSharePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onPause() {
        super.onPause();
        // In a voice channel the WebView must keep running (timers, WebSocket, audio) when the
        // app goes to the background; the foreground service keeps the process alive.
        if (VoixexCallPlugin.inCall && getBridge() != null) {
            WebView webView = getBridge().getWebView();
            webView.onResume();
            webView.resumeTimers();
        }
    }
}
