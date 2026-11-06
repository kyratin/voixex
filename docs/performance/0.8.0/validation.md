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
