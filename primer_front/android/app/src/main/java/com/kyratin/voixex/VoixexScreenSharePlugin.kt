package com.kyratin.voixex

import android.app.Activity
import android.Manifest
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Process
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.PermissionState
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import io.livekit.android.LiveKit
import io.livekit.android.ConnectOptions
import io.livekit.android.AudioOptions
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.audio.MixerAudioBufferCallback
import io.livekit.android.audio.ScreenAudioCapturer
import io.livekit.android.room.Room
import io.livekit.android.room.participant.BackupVideoCodec
import io.livekit.android.room.participant.AudioTrackPublishOptions
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.track.CustomVideoPreset
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.Track
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
import livekit.org.webrtc.ScreenCapturerAndroid
import livekit.org.webrtc.audio.JavaAudioDeviceModule
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.LockSupport
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Screen sharing from the phone. The Android WebView has no getDisplayMedia, so the screen is
 * captured natively (MediaProjection) and published by a separate LiveKit participant
 * "<clientId>:screen" in the same room; viewers see it like any other screen share.
 *
 * JS: registerPlugin("VoixexScreenShare").start({ url, token, withAudio?, maxHeight?, fps?, bitrateKbps?, content? }) /
 * stop(), event "stopped" when Android or the user ends the capture.
 */
@CapacitorPlugin(
    name = "VoixexScreenShare",
    permissions = [Permission(alias = "screenAudio", strings = [Manifest.permission.RECORD_AUDIO])]
)
class VoixexScreenSharePlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var room: Room? = null
    private var pendingUrl: String? = null
    private var pendingToken: String? = null
    private var pendingQuality = Quality()
    private var pendingWithAudio = false
    private var pendingAudioReason: String? = null
    private var screenAudioTrack: LocalAudioTrack? = null
    private var screenAudioCapturer: ScreenAudioCapturer? = null

    /** maxHeight is the short side (1080 = "1080p" whether the phone is upright or sideways). */
    private data class Quality(
        val maxHeight: Int = 1080,
        val fps: Int = 30,
        val bitrateKbps: Int = 6000,
        val detail: Boolean = false
    )

    @PluginMethod
    fun start(call: PluginCall) {
        if (call.getBoolean("withAudio", false) == true && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            getPermissionState("screenAudio") != PermissionState.GRANTED) {
            requestPermissionForAlias("screenAudio", call, "onScreenAudioPermission")
            return
        }
        startCapture(call)
    }

    @PermissionCallback
    private fun onScreenAudioPermission(call: PluginCall) {
        // Denying audio permission still allows an ordinary video-only share.
        startCapture(call)
    }

    private fun startCapture(call: PluginCall) {
        val url = call.getString("url")
        val token = call.getString("token")
        if (url.isNullOrEmpty() || token.isNullOrEmpty()) {
            call.reject("url and token are required")
            return
        }
        pendingUrl = url
        pendingToken = token
        val requestedAudio = call.getBoolean("withAudio", false) == true
        pendingWithAudio = requestedAudio && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            getPermissionState("screenAudio") == PermissionState.GRANTED
        pendingAudioReason = when {
            !requestedAudio -> null
            Build.VERSION.SDK_INT < Build.VERSION_CODES.Q -> "Screen audio requires Android 10 or newer"
            !pendingWithAudio -> "Audio capture permission was not granted"
            else -> null
        }
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
        val withAudio = pendingWithAudio
        val audioReason = pendingAudioReason
        if (result.resultCode != Activity.RESULT_OK || data == null || url == null || token == null) {
            call.resolve(JSObject().put("started", false).put("reason", "denied"))
            return
        }
        scope.launch {
            try {
                stopRoom()
                val next = LiveKit.create(
                    context.applicationContext,
                    roomOptions(pendingQuality),
                    overrides = LiveKitOverrides(audioOptions = AudioOptions(
                        audioHandler = NoAudioHandler(),
                        disableAudioPrewarming = true,
                        disableCommunicationModeWorkaround = true,
                        javaAudioDeviceModuleCustomizer = { builder ->
                            builder.setSampleRate(48_000).setUseStereoInput(false)
                                .setUseHardwareAcousticEchoCanceler(false).setUseHardwareNoiseSuppressor(false)
                        }
                    ))
                )
                // The auxiliary participant must never open a second physical microphone.
                // In the pinned WebRTC SDK this disables AudioRecord creation/start, while
                // leaving clocked custom audio callbacks available for playback capture.
                (next.lkObjects.audioDeviceModule as? JavaAudioDeviceModule)?.setAudioRecordEnabled(false)
                // This auxiliary participant only publishes. Subscribing would play the call
                // a second time through Android's native audio output, bypassing the WebView.
                room = next
                next.connect(url, token, ConnectOptions(autoSubscribe = false))
                val ok = next.localParticipant.setScreenShareEnabled(
                    true,
                    ScreenCaptureParams(
                        mediaProjectionPermissionResultData = data,
                        onStop = {
                            // Ended from the system UI (notification, quick settings).
                            scope.launch {
                                if (room === next) {
                                    stopRoom()
                                    notifyListeners("stopped", JSObject())
                                }
                            }
                        }
                    )
                )
                if (!ok) {
                    stopRoom()
                    call.resolve(JSObject().put("started", false).put("reason", "publish failed"))
                    return@launch
                }
                var audioStarted = false
                var finalAudioReason = audioReason
                if (withAudio && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    try {
                        audioStarted = startScreenAudio(next)
                        if (!audioStarted) finalAudioReason = "Screen audio capture is unavailable"
                    } catch (_: Throwable) {
                        stopScreenAudio(next)
                        finalAudioReason = "Screen audio capture is unavailable"
                    }
                }
                call.resolve(JSObject().put("started", true).put("audioStarted", audioStarted)
                    .put("audioReason", finalAudioReason))
            } catch (e: Throwable) {
                stopRoom()
                call.resolve(JSObject().put("started", false).put("reason", e.message ?: e.toString()))
            }
        }
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.Q)
    private suspend fun startScreenAudio(current: Room): Boolean {
        val adm = current.lkObjects.audioDeviceModule as? JavaAudioDeviceModule ?: return false
        adm.setAudioRecordEnabled(false)
        val video = current.localParticipant.getTrackPublication(Track.Source.SCREEN_SHARE)?.track as? LocalVideoTrack ?: return false
        val projection = (video.capturer as? ScreenCapturerAndroid)?.mediaProjection ?: return false
        val capturer = ScreenAudioCapturer(projection) { builder ->
            builder.addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .excludeUid(Process.myUid())
        }
        // Fail before publishing if Android cannot create the playback-only AudioRecord.
        if (!capturer.initAudioRecord(AudioFormat.ENCODING_PCM_16BIT, 1, 48_000)) {
            capturer.releaseAudioResources()
            return false
        }
        screenAudioCapturer = capturer
        val track = current.localParticipant.createAudioTrack("screen_audio", LocalAudioTrackOptions(
            noiseSuppression = false, echoCancellation = false, autoGainControl = false,
            highPassFilter = false, typingNoiseDetection = false
        ))
        screenAudioTrack = track
        val failed = AtomicBoolean(false)
        track.setAudioBufferCallback(object : MixerAudioBufferCallback() {
            override fun onBufferRequest(originalBuffer: ByteBuffer, audioFormat: Int, channelCount: Int,
                sampleRate: Int, bytesRead: Int, captureTimeNs: Long): BufferResponse? {
                val started = System.nanoTime()
                try {
                    // Refuse a route/format change rather than interpreting 44.1 kHz or stereo
                    // playback as our 48 kHz mono capture, which would change pitch or timing.
                    val compatible = sampleRate == 48_000 && channelCount == 1 &&
                        (audioFormat == AudioFormat.ENCODING_PCM_16BIT || audioFormat == AudioFormat.ENCODING_DEFAULT)
                    val response = if (compatible) capturer.onBufferRequest(originalBuffer, audioFormat, channelCount,
                        sampleRate, bytesRead, captureTimeNs) else null
                    if (response == null && failed.compareAndSet(false, true)) scope.launch {
                        if (room === current) {
                            stopScreenAudio(current)
                            notifyListeners("audioStopped", JSObject().put("reason", "Screen audio capture stopped"))
                        }
                    }
                    return response
                } finally {
                    // Recording-less ADM has no mic read to pace it. A revoked/failed playback
                    // capturer must not spin or flood the sender with unclocked silent buffers.
                    val remaining = 10_000_000L - (System.nanoTime() - started)
                    if (remaining > 0) LockSupport.parkNanos(remaining)
                }
            }
        })
        val published = current.localParticipant.publishAudioTrack(track, AudioTrackPublishOptions(
            name = "screen_audio", source = Track.Source.SCREEN_SHARE_AUDIO, audioBitrate = 96_000, dtx = false
        ))
        val active = published && room === current && screenAudioTrack === track
        if (!active && room === current && screenAudioTrack === track) stopScreenAudio(current)
        return active
    }

    private fun stopScreenAudio(current: Room) {
        val track = screenAudioTrack
        screenAudioTrack = null
        try {
            if (track != null) {
                try { current.localParticipant.unpublishTrack(track) } catch (_: Throwable) { }
                try { track.dispose() } catch (_: Throwable) { }
            }
        } finally {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) screenAudioCapturer?.releaseAudioResources()
            } catch (_: Throwable) { /* room.release still tears down the native audio stack */ }
            screenAudioCapturer = null
        }
        // Keep the paced callback until room.release: removing it while recording-less ADM is
        // winding down could briefly busy-spin its audio thread. It owns no live AudioRecord now.
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
        stopScreenAudio(current)
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
        if (current != null) stopScreenAudio(current)
        current?.disconnect()
        current?.release()
        scope.cancel()
        super.handleOnDestroy()
    }
}
