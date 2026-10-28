package com.kyratin.voixex

import android.app.Activity
import android.media.projection.MediaProjectionManager
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.room.Room
import io.livekit.android.room.participant.BackupVideoCodec
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.track.CustomVideoPreset
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoCodec
import io.livekit.android.room.track.VideoEncoding
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import livekit.org.webrtc.RtpParameters
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Screen sharing from the phone. The Android WebView has no getDisplayMedia, so the screen is
 * captured natively (MediaProjection) and published by a separate LiveKit participant
 * "<clientId>:screen" in the same room; viewers see it like any other screen share.
 *
 * JS: registerPlugin("VoixexScreenShare").start({ url, token, maxHeight?, fps?, bitrateKbps?, content? }) /
 * stop(), event "stopped" when Android or the user ends the capture.
 */
@CapacitorPlugin(name = "VoixexScreenShare")
class VoixexScreenSharePlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var room: Room? = null
    private var pendingUrl: String? = null
    private var pendingToken: String? = null
    private var pendingQuality = Quality()

    /** maxHeight is the short side (1080 = "1080p" whether the phone is upright or sideways). */
    private data class Quality(
        val maxHeight: Int = 1080,
        val fps: Int = 30,
        val bitrateKbps: Int = 6000,
        val detail: Boolean = false
    )

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
        pendingQuality = Quality(
            maxHeight = (call.getInt("maxHeight") ?: 1080).coerceIn(360, 1440),
            fps = (call.getInt("fps") ?: 30).coerceIn(10, 60),
            bitrateKbps = (call.getInt("bitrateKbps") ?: 6000).coerceIn(800, 10000),
            detail = call.getString("content") == "detail"
        )
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
                val next = LiveKit.create(context.applicationContext, roomOptions(pendingQuality))
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

    /**
     * The SDK defaults made phone streams choppy: the full panel (up to 1440x3200) encoded as VP8,
     * a "keep resolution" policy that drops frames whenever the encoder falls behind, and a
     * half-size simulcast layer at 3 fps that small or "auto" viewers were given.
     * Instead: a scaled capture, the hardware H.264 encoder, frame rate first, and a usable low layer.
     */
    private fun roomOptions(q: Quality): RoomOptions {
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        context.getSystemService(WindowManager::class.java).defaultDisplay.getRealMetrics(metrics)
        val nativeLong = max(metrics.widthPixels, metrics.heightPixels)
        val nativeShort = min(metrics.widthPixels, metrics.heightPixels).coerceAtLeast(1)
        val short = min(q.maxHeight, nativeShort)
        // Hardware encoders want sizes in multiples of 16.
        val long = align16(nativeLong * short.toDouble() / nativeShort)
        val shortAligned = align16(short.toDouble())
        val fps = q.fps
        val encoding = VideoEncoding(q.bitrateKbps * 1000, fps)
        val lowShort = min(360, shortAligned)
        val lowLayer = CustomVideoPreset(
            VideoCaptureParameter(align16(long * lowShort.toDouble() / shortAligned), lowShort, min(fps, 20), adaptOutputToDimensions = false),
            VideoEncoding(700_000, min(fps, 20))
        )
        return RoomOptions(
            adaptiveStream = false,
            // Layers nobody watches are paused, which spares the phone's encoder.
            dynacast = true,
            screenShareTrackCaptureDefaults = LocalVideoTrackOptions(
                isScreencast = true,
                captureParams = VideoCaptureParameter(long, shortAligned, fps, adaptOutputToDimensions = false)
            ),
            screenShareTrackPublishDefaults = VideoTrackPublishDefaults(
                videoEncoding = encoding,
                simulcast = true,
                videoCodec = VideoCodec.H264.codecName,
                backupCodec = BackupVideoCodec(codec = VideoCodec.VP8.codecName),
                degradationPreference = if (q.detail) {
                    RtpParameters.DegradationPreference.BALANCED
                } else {
                    RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE
                },
                simulcastLayers = listOf(lowLayer)
            )
        )
    }

    private fun align16(v: Double) = max(16, (v / 16).roundToInt() * 16)

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
