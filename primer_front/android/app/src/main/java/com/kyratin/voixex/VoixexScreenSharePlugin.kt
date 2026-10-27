package com.kyratin.voixex

import android.app.Activity
import android.media.projection.MediaProjectionManager
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import io.livekit.android.LiveKit
import io.livekit.android.room.Room
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Screen sharing from the phone. The Android WebView has no getDisplayMedia, so the screen is
 * captured natively (MediaProjection) and published by a separate LiveKit participant
 * "<clientId>:screen" in the same room; viewers see it like any other screen share.
 *
 * JS: registerPlugin("VoixexScreenShare").start({ url, token }) / stop(),
 * event "stopped" when Android or the user ends the capture.
 */
@CapacitorPlugin(name = "VoixexScreenShare")
class VoixexScreenSharePlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var room: Room? = null
    private var pendingUrl: String? = null
    private var pendingToken: String? = null

    @PluginMethod
    fun start(call: PluginCall) {
        val url = call.getString("url")
        val token = call.getString("token")
        if (url.isNullOrEmpty() || token.isNullOrEmpty()) {
            call.reject("url and token are required")
            return
        }
        pendingUrl = url
        pendingToken = token
        val manager = context.getSystemService(MediaProjectionManager::class.java)
        startActivityForResult(call, manager.createScreenCaptureIntent(), "onProjectionResult")
    }

    @ActivityCallback
    private fun onProjectionResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val data = result.data
        val url = pendingUrl
        val token = pendingToken
        if (result.resultCode != Activity.RESULT_OK || data == null || url == null || token == null) {
            call.resolve(JSObject().put("started", false).put("reason", "denied"))
            return
        }
        scope.launch {
            try {
                stopRoom()
                val next = LiveKit.create(context.applicationContext)
                next.connect(url, token)
                room = next
                val ok = next.localParticipant.setScreenShareEnabled(
                    true,
                    ScreenCaptureParams(
                        mediaProjectionPermissionResultData = data,
                        onStop = {
                            // Ended from the system UI (notification, quick settings).
                            scope.launch {
                                stopRoom()
                                notifyListeners("stopped", JSObject())
                            }
                        }
                    )
                )
                if (!ok) {
                    stopRoom()
                    call.resolve(JSObject().put("started", false).put("reason", "publish failed"))
                    return@launch
                }
                call.resolve(JSObject().put("started", true))
            } catch (e: Throwable) {
                stopRoom()
                call.resolve(JSObject().put("started", false).put("reason", e.message ?: e.toString()))
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        scope.launch {
            stopRoom()
            call.resolve()
        }
    }

    private suspend fun stopRoom() {
        val current = room ?: return
        room = null
        try {
            current.localParticipant.setScreenShareEnabled(false)
        } catch (_: Throwable) {
            // Already stopped by the system.
        }
        current.disconnect()
        current.release()
    }

    override fun handleOnDestroy() {
        val current = room
        room = null
        current?.disconnect()
        current?.release()
        scope.cancel()
        super.handleOnDestroy()
    }
}
