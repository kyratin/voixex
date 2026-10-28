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
    /** Picture-in-picture when leaving the app during a call (the app's "Mini call window" setting). */
    static volatile boolean pipEnabled = true;
    private static VoixexCallPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    /** Notification / picture-in-picture button pressed: "toggle_mute" or "leave". */
    static void emitAction(String action) {
        VoixexCallPlugin plugin = instance;
        if (plugin != null) plugin.notifyListeners("action", new JSObject().put("action", action));
    }

    static void emitPip(boolean active) {
        VoixexCallPlugin plugin = instance;
        if (plugin != null) plugin.notifyListeners("pip", new JSObject().put("active", active));
    }

    private void refreshPip() {
        if (getActivity() instanceof MainActivity) {
            MainActivity activity = (MainActivity) getActivity();
            activity.runOnUiThread(activity::updatePictureInPicture);
        }
    }

    /** Channel name, mute state and translated button labels for the notification and PiP. */
    @PluginMethod
    public void update(PluginCall call) {
        VoixexCallService.title = call.getString("title", VoixexCallService.title);
        VoixexCallService.text = call.getString("text", VoixexCallService.text);
        VoixexCallService.muted = Boolean.TRUE.equals(call.getBoolean("muted", VoixexCallService.muted));
        VoixexCallService.muteLabel = call.getString("muteLabel", VoixexCallService.muteLabel);
        VoixexCallService.unmuteLabel = call.getString("unmuteLabel", VoixexCallService.unmuteLabel);
        VoixexCallService.leaveLabel = call.getString("leaveLabel", VoixexCallService.leaveLabel);
        VoixexCallService.refresh(getContext());
        refreshPip();
        call.resolve();
    }

    @PluginMethod
    public void setPip(PluginCall call) {
        pipEnabled = Boolean.TRUE.equals(call.getBoolean("enabled", true));
        refreshPip();
        call.resolve();
    }

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
            refreshPip();
            call.resolve(new JSObject().put("started", true));
        } catch (Exception e) {
            // Android refuses to start it from the background; the call still works in the foreground.
            call.resolve(new JSObject().put("started", false).put("reason", e.getMessage()));
        }
    }

    /** Stream fullscreen: "landscape" turns the screen sideways, "auto" gives rotation back. */
    @PluginMethod
    public void setOrientation(PluginCall call) {
        String mode = call.getString("mode", "auto");
        getActivity().runOnUiThread(() -> {
            getActivity().setRequestedOrientation(
                "landscape".equals(mode)
                    ? android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    : android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            );
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        inCall = false;
        getContext().stopService(new Intent(getContext(), VoixexCallService.class));
        refreshPip();
        call.resolve();
    }
}
