# 0.8.1 voice regression diagnosis and validation

## Confirmed failure

The actual Chromium WebVoiceEngine microphone could transmit correctly before a silence/demand gap, then permanently stop transmitting encoded speech while capture and probes continued. A newly joined participant could still work with a fresh encoder.

Opus output timestamps followed a continuous codec timeline across a gap in submitted AudioData timestamps. The 0.8.0 output handler looked up metadata by the output timestamp converted to a network frame number. Network frame numbers intentionally jump across pauses. After the clocks diverged, the metadata lookup failed and valid Opus packets were discarded. Earlier tests used synchronous Node Opus for uplink; the browser voice test covered SFU playback, not this WebCodecs uplink path.

The failure was reproduced with a real browser microphone tone sent through the production media worker to real TCP and WebSocket client decoders. Before the fix, capture advanced from 112 to 221 frames after demand resumed but listener tone counts remained 111/112 and only probes were transmitted. The patch restored continuous audible output in that same scenario.

## Fix

Match each ordered Opus output to the oldest submitted metadata entry, independent of codec timestamps. Retain expired entries until their output arrives so later output cannot be matched to the wrong capture frame. Keep at most 4 pending entries and the existing 80ms audio deadline. Three consecutive late outputs or an encoder with no output for 160ms trigger compatible PCM for subsequent live frames. Room and socket resets close the previous encoder, and callback identity guards reject its delayed output.

## Checks

- `browser-uplink-check.mjs`: actual Chromium AudioEncoder, WebCrypto, production worker, Node TCP and WebSocket decoders. Three participants; 700ms digital silence; mute/unmute; demand suspension/resumption; third participant leave/rejoin. Every phase retains audible 500Hz voice; stays Opus with no fallback in the healthy case.
- `webcodecs-queue-recovery-check.mjs`: real Chromium encoder and WebCrypto under 120ms JS stalls; deadline recovery; a real encoder whose callbacks are swallowed; bounded pending metadata; room/reconnect cancellation. Output resumes through PCM rather than remaining muted.
- `voice-turntaking.mjs`: staggered joins and independent capture clocks, eight source combinations, mixed transports, demand transitions, third leave/rejoin. 25 checks passed against 0.8.0; 11 compatibility checks against the actual 0.7.3 image.
- Frontend TypeScript, frontend production build, desktop build, audio worklet timing/pitch checks, and existing priority/encryption/room cancellation checks passed.

No server runtime change was required. Production was temporarily rolled back to 0.7.3 while diagnosing. The corrected client is 0.8.1; the optimized compatible server image is 0.8.0. Physical Android hardware remains unverified; the corrected WebCodecs path is exercised by actual Chromium rather than a fake encoder.
