package com.kyratin.voixex;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

/**
 * Keeps the app process (and its WebView voice engine) alive while the user is in a voice
 * channel with the app in the background or the screen off.
 */
public class VoixexCallService extends Service {
    static final String CHANNEL_ID = "voixex_call";
    static final int NOTIFICATION_ID = 4101;
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";

    private PowerManager.WakeLock wakeLock;

    /** Buttons in the notification and in picture-in-picture; handled by the page. */
    static final String ACTION_TOGGLE_MUTE = "com.kyratin.voixex.TOGGLE_MUTE";
    static final String ACTION_LEAVE = "com.kyratin.voixex.LEAVE";

    /** What the notification shows; the page keeps it current through VoixexCall.update(). */
    static volatile String title = "Voixex";
    static volatile String text = "";
    static volatile boolean muted = false;
    static volatile String muteLabel = "Mute";
    static volatile String unmuteLabel = "Unmute";
    static volatile String leaveLabel = "Leave";

    static PendingIntent actionIntent(Context context, String action, int requestCode) {
        Intent intent = new Intent(context, VoixexCallService.class).setAction(action);
        return PendingIntent.getService(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static Notification buildNotification(Context context) {
        Intent open = new Intent(context, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(contentIntent)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .addAction(
                muted ? android.R.drawable.ic_btn_speak_now : android.R.drawable.ic_lock_silent_mode,
                muted ? unmuteLabel : muteLabel,
                actionIntent(context, ACTION_TOGGLE_MUTE, 1)
            )
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, leaveLabel, actionIntent(context, ACTION_LEAVE, 2))
            .build();
    }

    /** Redraws the running notification after the page changed its state. */
    static void refresh(Context context) {
        if (!VoixexCallPlugin.inCall) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        try {
            nm.notify(NOTIFICATION_ID, buildNotification(context));
        } catch (SecurityException e) {
            // Notifications not allowed: the buttons are still in picture-in-picture.
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_TOGGLE_MUTE.equals(action)) {
            VoixexCallPlugin.emitAction("toggle_mute");
            return START_NOT_STICKY;
        }
        if (ACTION_LEAVE.equals(action)) {
            VoixexCallPlugin.emitAction("leave");
            return START_NOT_STICKY;
        }
        if (intent != null && intent.getStringExtra(EXTRA_TITLE) != null) title = intent.getStringExtra(EXTRA_TITLE);
        if (intent != null && intent.getStringExtra(EXTRA_TEXT) != null) text = intent.getStringExtra(EXTRA_TEXT);
        createChannel();
        Notification notification = buildNotification(this);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (RuntimeException e) {
            // Not allowed right now (permission missing, app not in the foreground): the call keeps
            // working while the app is open, so stop instead of crashing the whole app.
            stopSelf();
            return START_NOT_STICKY;
        }
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "voixex:call");
            wakeLock.acquire(6 * 60 * 60 * 1000L);
        }
        return START_NOT_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Voice channel", NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
