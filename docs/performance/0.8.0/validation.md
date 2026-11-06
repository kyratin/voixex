# 0.8.0 release validation

## CPU-only comparison

Same Apple M4 host, native Linux ARM64 Docker, one CPU quota, Node22, 75 warm-up ticks followed by 150 measured 20ms ticks. The baseline is the published 0.7.3 image; the candidate uses the updated production media core. Both use real AES-GCM and Opus. The candidate advertises `mix3`; the baseline uses `opus2 camera1`. Inactive microphones in this CPU calibration are muted. Camera payloads are synthetic 10KB JPEG frames at 30fps. Queued candidate sends are synchronously drained so deferred camera work is counted.

| Members / speakers / cameras | Baseline CPU ms/tick | Candidate CPU ms/tick | Reduction |
| --- | ---: | ---: | ---: |
| 25 / 4 / 0 | 5.06 | 1.80 | 64% |
| 100 / 4 / 0 | 18.77 | 2.17 | 88% |
| 25 / 25 / 0 | 7.35 | 6.37 | 13% |
| 12 / 4 / 12 | 8.04 | 7.53 | 6% |

These are CPU-cost measurements, not call-latency or production-user guarantees. Sharing helps most when listeners receive the same mix. Active speakers and custom gains create additional cohorts. Camera fan-out bandwidth is unchanged: 12 cameras and 12 members still consume about 371Mbps including protocol overhead in this fixture. Do not extrapolate M4 timings to the production Xeon.

Raw results: `core-baseline.json`, `core-optimized.json`. Reproduce with `tools/performance/core-cost.mjs`; set `CLIENT_CAPS="opus2 camera1 mix3"` for the candidate.

## Functional checks

- Client: silence/quiet speech, camera assembly/reorder/loss, bounded priority/deadline queues, Opus churn/PLC and invalid inputs.
- Server: sum/self-exclusion/custom gains, shared encoder cohorts, password worker event-loop isolation/overload/expiry.
- Transports: UDP/TCP/WebSocket voice with camera traffic, loss, mute, leave/rejoin; all six camera route pairs and 30fps sustained relay.
- Compatibility/demand: original PCM, Opus2, and mix3 peers coexist; no-receiver suppression, JPEG/SFU transitions, and lease-expiry fallback.
- Browser: audible 3-member WebRTC voice, missing/paused track fallback, mode churn, camera-only hidden subscriptions, layout bounds, renderer stalls and capture timing.
- WebCrypto queue: priority over JPEG, monotonically increasing wire sequence, 80ms audio expiry and old-room cancellation.

## Remaining boundaries

One media worker still owns all rooms; CPU allocation alone does not shard a room. Visible camera mode subscribes to all camera publications, even when the UI pages them 12 at a time. Physical Android audio devices, cellular links and congested Wi-Fi require device testing. Complete loss of all initial shared-stream warm-up packets can cause a brief Opus predictor convergence artifact before later packets restore context.

## Real-time one-CPU Docker bridge checks

The final 0.8.0 server image was limited to one CPU / 1536MiB on the same M4 host. Generated AES/Opus UDP peers ran in a separate container; no macOS UDP port-forwarding path or production cluster traffic was used. Each 20-second measurement followed 5 seconds warm-up. The 120-second soak included the actual built desktop VoiceEngine as the last participant.

| Scenario | CPU average | Median received fps | Probe RTT p95 | Marker arrival p95 |
| --- | ---: | ---: | ---: | ---: |
| compat-open100-s4 | 94.2% | 45.2 | 219 ms | 460 ms |
| mix3-open100-s4 | 43.2% | 50 | 3 ms | 158 ms |
| mix3-open100-silent | 35.4% | 8.05 | 7 ms | — |
| mix3-soak20-s4 | 26.5% | 50 | 7 ms | 53 ms |
| mix3-gated100-s4 | 26.2% | 50 | 4 ms | 92 ms |
| mix3-gated100-silent | 3.3% | 0 | 9 ms | — |

`compat-open100-s4` and `mix3-open100-s4` both deliberately transmit encoded silence from 96 unmuted peers: they isolate negotiated downlink sharing under identical input load. The new client's silence admission saves additional uplink/decoder work. The ungated silence fixture loops pre-encoded Opus banks and may produce short predictor transients, so it is an adversarial traffic check, not a microphone-noise or audible-silence certification.

The 20-participant soak observer received 6000 PCM frames (50fps), zero estimated loss and zero concealed frames. Its 500Hz synthetic marker remained 500Hz in every measured frame; marker latency p95 was 90ms before UI playback/hardware/WAN. Aggregate server decode/encode/worker errors were zero. This measures pitch preservation for the synthetic signal; physical Android capture/playback is still unverified.

The 100-peer compatibility case remained CPU saturated with 45.2fps and 219ms probe p95: updating the server alone does not remove old-client encoder work. Negotiated sharing restored 50fps and 3ms probe p95 in the same ungated fixture, but this M4 measurement does not certify 100 users on the production Xeon.


With the actual client `SilenceGate` applied to generated speech/zero RMS (`mix3-gated100-s4`), the 100 unmuted-peer fixture used 26.17% CPU, delivered 50fps to every listener and had 92ms marker p95. The all-silent gated case used 3.34% CPU and sent no audio packets, as intended. These apply the real gate class to known synthetic RMS before Opus submission; they are not full microphone/capture pipeline tests. Both cases acknowledged all 100 sessions and had no codec/worker errors or generator skipped ticks.

## Published artifacts and rollout

- Client tag: `v0.8.0`, source `6f62ceff3b15a60f730db6d7d0f633083ab73eef`; Android APK, macOS ARM64 DMG, Windows x64 EXE. GitHub release workflow and Camera validation passed.
- Server source: `5b7ef7f`, dual-architecture runtime tests and actual API smoke passed.
- Docker Hub `kyratinkokko/voixex:0.8.0` and `latest` share index `sha256:a67c325e3e53214372bd229ffd6485dc66b995f3361875326b18429ddab3676c`, containing Linux AMD64 and ARM64 (plus build attestations).
- Existing `voixex` deployment updated to 0.8.0 with its original PVC and configuration; rollout completed and public `/health` returned `{"ok":true}`.
