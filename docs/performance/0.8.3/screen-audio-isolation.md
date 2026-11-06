# Screen audio isolation in 0.8.3

## Capture contract

Voixex must remain audible locally but must not be included in the audio published alongside a screen share. Other applications' permitted playback remains eligible for capture. Microphone voice and screen sound remain separate tracks.

Desktop capture requests `restrictOwnAudio:true` and `suppressLocalAudioPlayback:false`. The result is accepted only when the runtime supports the constraint, the OS supports process exclusion, and the live track reports `restrictOwnAudio:true`. A failure retries video only; unsupported, unconfirmed or ended audio is stopped and removed. The retry never requests unrestricted loopback. Cancelling permission does not trigger a second picker. Choosing a visual source remains unchanged.

Electron 37 lacked the constraint forwarding required for native exclusion. The app pins 43.8.7, which includes the fix first released in 43.4.0. Capability is computed in the main process and exposed as a boolean in the sandboxed preload for all windows. Ordinary Windows 10 builds below 20348 cannot use the native process exclusion path and therefore share video only. macOS 13+ supports the screen-audio capture API; recording permission and an actually live confirmed track are still required.

## Android

The auxiliary `:screen` participant is publish-only, does not change the main call's audio focus, and does not subscribe to remote audio. Existing server tokens already forbid its subscriptions; the explicit client option is defense in depth, not the primary desktop bug cause.

Android 10+ uses playback capture for MEDIA/GAME/UNKNOWN usage and explicitly excludes `Process.myUid()`. Manifest and runtime capture policy also exclude Voixex playback. The native ADM is put into recording-less mode before connecting or creating audio tracks, so it does not open a second physical microphone or interrupt the WebView voice capture. The playback-only capture is 48kHz mono and rejects unexpected callback formats instead of changing pitch. A paced callback avoids busy spinning if capture is revoked. The track is published as `SCREEN_SHARE_AUDIO`, never as call microphone voice. Stop, failure and projection revocation release capture; a failed audio track can stop while the video continues.

Android captures only playback that the source app allows. Protected/non-capturable application audio remains unavailable by OS policy.

## Validation boundaries

- Browser capture contract regression checks the actual helper with an injected capture provider: exclusion constraints, local playback retained, platform/feature gates, live/settings checks, and safe video-only fallbacks. This does not certify native OS filtering.
- Desktop capture policy tests cover nine OS/runtime boundaries. Desktop TypeScript and frontend TypeScript/production build pass.
- Native Kotlin compiled successfully in the Android check workflow (run 42207800255, candidate 2d76252). Full browser/media checks also passed (run 42207800271). No physical Android device is connected; device-level capture and main-microphone coexistence cannot be certified by compilation.
- A macOS two-process probe uses an own-app 440Hz tone and external-app 1000Hz tone and reports only spectral magnitudes, with no recording of screen contents. Its result must be recorded separately rather than inferred from browser contract tests.

## Primary references

- [Electron native restrictOwnAudio fix and backport versions](https://releases.electronjs.org/pr/52455).
- [W3C restrictOwnAudio constraint](https://www.w3.org/TR/screen-capture/#def-constraint-restrictOwnAudio).
- [Windows process loopback capture availability](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/).
- [Android playback capture, UID exclusion and source policies](https://developer.android.com/media/platform/av-capture).
- [Pinned LiveKit 2.28.2 ScreenAudioCapturer](https://github.com/livekit/client-sdk-android/blob/v2.28.2/livekit-android-sdk/src/main/java/io/livekit/android/audio/ScreenAudioCapturer.kt).


## Actual macOS result

Electron 43.8.7 / Chromium 150.0.7871.250 on macOS 26.6.2 was tested with its own 440Hz output and a separate `afplay` process playing 1000Hz. Own-app capture amplitude fell from 0.0120324 in an unrestricted positive control to 0.00003196 with exclusion (about 51.5dB attenuation); the external source stayed 0.00733 (under 0.4% change). Starting capture before the own-app tone and enabling it one second later also passed (about 52.6dB attenuation). The track reported `restrictOwnAudio:true` and `suppressLocalAudioPlayback:false`. No additional output keepalive was needed.

Raw spectral results and measurement limits: `mac-native-audio-probe.json`. `desktop-client/scripts/screen-audio-native-probe.cjs` preserves the manual in-memory probe. Run through the pinned Electron CLI with pre-granted screen/system-audio permissions and an external 1000Hz player; `VOIXEX_PROBE_IDLE_FIRST=1` starts the own-app tone after capture, and `VOIXEX_PROBE_RESTRICT=0` is the unrestricted positive control. The positive control exists only in this manual test and is never a production fallback. No screen or captured audio recording is written.
