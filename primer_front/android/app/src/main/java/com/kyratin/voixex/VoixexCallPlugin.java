package com.kyratin.voixex;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** JS: registerPlugin("VoixexCall").start({ title, text }) / stop(), see lib/mobile-bridge.ts. */
@CapacitorPlugin(
    name = "VoixexCall",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class VoixexCallPlugin extends Plugin {
    /** Read by MainActivity: keep the WebView running in the background during a call. */
    static volatile boolean inCall = false;

    @PluginMethod
    public void start(PluginCall call) {
        // A microphone-type foreground service may only start once RECORD_AUDIO is granted
        // (Android 14+ throws SecurityException otherwise, which crashed the app on joining).
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicrophonePermission");
            return;
        }
        afterMicrophonePermission(call);
    }

    @PermissionCallback
    private void afterMicrophonePermission(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.resolve(new JSObject().put("started", false).put("reason", "microphone permission denied"));
            return;
        }
        // Android 13+: ask once for the notification the foreground service shows.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") == PermissionState.PROMPT) {
            requestPermissionForAlias("notifications", call, "afterNotificationPermission");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        // Without the permission the service still runs; only its notification is hidden.
        startService(call);
    }

    private void startService(PluginCall call) {
        Intent intent = new Intent(getContext(), VoixexCallService.class)
            .putExtra(VoixexCallService.EXTRA_TITLE, call.getString("title", "Voixex"))
            .putExtra(VoixexCallService.EXTRA_TEXT, call.getString("text", ""));
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            inCall = true;
            call.resolve(new JSObject().put("started", true));
        } catch (Exception e) {
            // Android refuses to start it from the background; the call still works in the foreground.
            call.resolve(new JSObject().put("started", false).put("reason", e.getMessage()));
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        inCall = false;
        getContext().stopService(new Intent(getContext(), VoixexCallService.class));
        call.resolve();
    }
}
