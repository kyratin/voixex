package com.kyratin.voixex;

import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.res.Configuration;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.webkit.WebView;
import androidx.annotation.RequiresApi;
import com.getcapacitor.BridgeActivity;
import java.util.ArrayList;
import java.util.List;

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

    private boolean wantsPictureInPicture() {
        return VoixexCallPlugin.inCall && VoixexCallPlugin.pipEnabled;
    }

    /**
     * During a call, leaving the app shrinks it to a floating window (like Google Meet) that the
     * page fills with the participants. Mute and leave are system buttons on that window.
     */
    void updatePictureInPicture() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            setPictureInPictureParams(buildPipParams());
        } catch (IllegalStateException | IllegalArgumentException e) {
            // Device without picture-in-picture.
        }
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private PictureInPictureParams buildPipParams() {
        List<RemoteAction> actions = new ArrayList<>();
        boolean muted = VoixexCallService.muted;
        String muteLabel = muted ? VoixexCallService.unmuteLabel : VoixexCallService.muteLabel;
        actions.add(new RemoteAction(
            Icon.createWithResource("android", muted ? android.R.drawable.ic_btn_speak_now : android.R.drawable.ic_lock_silent_mode),
            muteLabel,
            muteLabel,
            VoixexCallService.actionIntent(this, VoixexCallService.ACTION_TOGGLE_MUTE, 1)
        ));
        actions.add(new RemoteAction(
            Icon.createWithResource("android", android.R.drawable.ic_menu_close_clear_cancel),
            VoixexCallService.leaveLabel,
            VoixexCallService.leaveLabel,
            VoixexCallService.actionIntent(this, VoixexCallService.ACTION_LEAVE, 2)
        ));
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder()
            .setAspectRatio(new Rational(4, 3))
            .setActions(actions);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+: the system enters picture-in-picture by itself, with a smooth animation.
            builder.setAutoEnterEnabled(wantsPictureInPicture()).setSeamlessResizeEnabled(false);
        }
        return builder.build();
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        // Android 8-11 have no auto-enter: go into picture-in-picture when the user leaves.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && Build.VERSION.SDK_INT < Build.VERSION_CODES.S && wantsPictureInPicture()) {
            try {
                enterPictureInPictureMode(buildPipParams());
            } catch (IllegalStateException | IllegalArgumentException e) {
                // Not supported here.
            }
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        VoixexCallPlugin.emitPip(isInPictureInPictureMode);
    }
}
