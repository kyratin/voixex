# 0.8.4 call feedback and screen sharing

## Live production evidence

A read-only LiveKit inspection during the reported active stream found screen video plus microphone, but no SCREEN_SHARE_AUDIO publication. The publisher was Electron 43.8.7 on Windows. Allowed publication sources explicitly included screen audio. The server was healthy (about 117m CPU, 155MiB), with no restarts. The user confirmed Windows 10 and the capture-unavailable warning. No production restart or config change was performed.

## Fixes and checks

- Self-speaking: the previous local threshold 0.012 RMS was much higher than remote level visibility. Align local detection with the server's −50..−12dB level scale (open 0.0036 / hold 0.0028), permit verified self legacy/SFU levels as fallback, and keep immediate mute suppression. Actual Chromium AudioContext→captureWorklet→Int16 RMS 0.005–0.007 now lights the real main and mini self-camera tile. Silence and mute clear it. Actual LiveKit tests verify own SFU levels, mute/unmute, unpublish/republish and disconnect.
- Pop-out continuity: repeated UI updates used to unbind, stop and recreate the live video clone. Preserve the clone/srcObject for the same live source and stop only owned clones. Main video rebind is idempotent too. Actual Chromium pop-out test ran 100 refreshes, retained identical stream/track, decoded 64 new frames and saw zero black pixels. Source change/close preserve the publisher; foreign streams are not stopped.
- Picker/audio: Electron 43.8.7's native picker wrapper returns only video and bypasses the application's audio callback. Use the existing application source selector (`useSystemPicker:false`), the same path proven by the 0.8.3 native macOS sound test. AST/handler tests cover source selection, audio on/off and cancellation.
- Windows 10: build 20348 was an over-restrictive preflight rule, not proof that every older process-loopback implementation is unavailable. Updated Windows 10 version 2004+ (19041+) can attempt isolated native capture. Activation must succeed and a live track must confirm `restrictOwnAudio:true`; failure never falls back to unrestricted system audio. This is eligibility to attempt capture, not certification on the user's specific machine. Physical Windows 10 verification remains required.

## Analogue research

| Product | Published capture approach | Relevant boundary |
| --- | --- | --- |
| Discord | OS-specific audio APIs; selected process and its children | Exact Windows audio API is not publicly identified in the cited overview. The separate DLL-injection article concerns video frames. |
| Google Meet | Tab audio separately; whole-device audio for screen/window sharing | Official requirements: Chrome 142+, Windows 11+ or macOS 14.2+. |
| OBS | Native per-application process-loopback audio | Official guide supports Windows 10 version 2004+. Source code sets minimum 19041 despite Microsoft's newer sample minimum. |

This research corrected the overly broad driver requirement previously stated for ordinary Windows 10. No virtual audio driver is required by this patch. If the native API actually fails on a particular machine, a separate native per-application backend/routing fallback remains a distinct option; it is not silently replaced with unrestricted loopback.

## Primary references

- [Discord capture pipeline](https://discord.com/blog/how-it-all-goes-live-an-overview-of-discords-streaming-technology).
- [Meet device-audio requirements](https://workspaceupdates.googleblog.com/2025/12/share-devices-audio-when-presenting.html?hl=en).
- [OBS application capture guide](https://obsproject.com/kb/application-audio-capture-guide).
- [OBS Windows audio minimum-build source](https://github.com/obsproject/obs-studio/blob/master/plugins/win-wasapi/plugin-main.cpp).
- [Electron 43.8.7 native picker wrapper](https://github.com/electron/electron/blob/v43.8.7/lib/browser/api/session.ts).
- [Chromium 150 native process-loopback capture](https://github.com/chromium/chromium/blob/150.0.7871.250/media/audio/win/audio_low_latency_input_win.cc): activation failure returns a failed open, while the without-Chrome device selects EXCLUDE_TARGET_PROCESS_TREE.
