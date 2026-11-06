# Voixex performance audit tools

The [2026-11-06 report](../../docs/performance/2026-11-06-capacity-audit.md) contains results, assumptions and limitations. These are isolated benchmark tools, not production endpoints. They do not modify the application source.

## Components

- `media-server.mjs`: HTTP fixture/metrics wrapper around the unchanged production `media.js` worker. No SQLite or SFU. **Never expose this unauthenticated fixture service publicly.**
- `media-clients.mjs`: separate generator workers with real HELLO, AES-GCM, Opus2, UDP/TCP/WebSocket, probes, camera fragmentation and sampled marker decoding. Optional observer imports the actual desktop `VoiceEngine`. Set case `clientCaps` to `"opus2 camera1 mix3"` to test the negotiated shared mix format; the default retains the original audit wire format.
- `run-matrix.mjs`: main 16-case media matrix. Run inside the generator container.
- `run-api.mjs` / `api.k6.js`: actual HTTP application, isolated disk volume, metadata reads, chat writes and password logins. k6 exit 99 means the latency threshold failed; inspect the results rather than treating it as a harness crash.
- `run-livekit.mjs`: official CLI load tests, with complete 25-track selection for the 25-source test, resource sampling and raw CLI results. Needs the versioned Linux CLI binary in `/tmp/voixex-performance/lk-linux/lk`.
- `run-extra.mjs`: open/quiet microphones, muted sessions, two-CPU comparison and 120-second soak. Run after API/SFU matrices; this restarts only the suite's media container.
- `run-muted.mjs`: optional independent 1000-muted-session check after the soak. The current extra matrix also includes that case; do not run both concurrently.
- `core-cost.mjs`: synchronous CPU-cost calibration using the real production core. `CASES`, `FRAMES`, `WARMUP_FRAMES` configure it. `CLIENT_CAPS="opus2 camera1 mix3"` enables negotiated shared mixes on newer servers; omit it for the compatibility baseline. Newer server queues are synchronously drained during this CPU-only calibration. It measures process CPU time; **CPU-quota wall time is not live-call latency**.
- `codec-cost.mjs`: synthetic encoder-complexity/decode component test.
- `summarize.mjs`: re-create a scenario summary from raw JSON, including large soak arrays without argument-spread limits.
- `collect-results.py`, `build-report.py`, `plot-results.py`: collect only the valid result directories, generate the English audit and plot. Plotting requires matplotlib. These scripts expect the documented audit output paths.

## Versions and local setup

Tested on Apple M4 with native Linux ARM64 Docker containers. The server image is pinned to its published multiarch digest. The official CLI was `livekit/livekit-cli` release `v2.19.3`, Linux ARM64. Use the matching Linux AMD64 asset on an AMD64 Docker host. k6 is pinned by digest in `run-api.mjs` (tested version 2.3.0).

Run host-side commands from the repository root. Prepare the real receiver with `npm ci --prefix voice-client` and `npm run build --prefix voice-client` if its dependencies/build are absent.

```sh
mkdir -p /tmp/voixex-performance/final /tmp/voixex-performance/lk-linux
docker network create voixex-perf-net
docker run --rm -d --name voixex-perf-media --network voixex-perf-net \
  --cpus 1 --memory 1536m --entrypoint node \
  -e TOKEN_SECRET=isolated-benchmark-only -e UDP_PORT=50000 -e UDP_HOST=0.0.0.0 \
  --mount type=bind,src="$PWD/tools/performance",dst=/bench,readonly \
  kyratinkokko/voixex@sha256:cd37a983383ca786e8bb4e71f9343f680f4c3d69a9843cec53db4b421f1a9aaa \
  /bench/media-server.mjs

docker run --rm --name voixex-perf-generator --network voixex-perf-net \
  --cpus 4 --memory 2048m --entrypoint node \
  -e BENCH_OUTPUT=/results/final -e BACKEND_ROOT=/app \
  --mount type=bind,src="$PWD/tools/performance",dst=/bench,readonly \
  --mount type=bind,src=/tmp/voixex-performance,dst=/results \
  kyratinkokko/voixex@sha256:cd37a983383ca786e8bb4e71f9343f680f4c3d69a9843cec53db4b421f1a9aaa \
  /bench/run-matrix.mjs
```

`CASE_FILTER` on the generator restricts the main matrix by case-name regex. The generator records counts to validate 50 fps audio, 1 Hz probes and 30 fps cameras. Synthetic camera data exercises relay/framing only, not JPEG render quality. Check generator skipped ticks and HELLO counts before attributing a failure to the target.

For API tests, create a **new test-only Docker volume** `voixex-perf-api-data` and an isolated `voixex-perf-api` container on this network, limited to one CPU / 1536 MiB. Mount that volume at `/data`; set `LIVEKIT_EMBEDDED=false`, `LEGACY_JOIN=open`, `TOKEN_SECRET=api-benchmark-local-only`, `SUPERUSER_PASSWORD=api-benchmark-admin-local-only`. The fixture server password and profile password in `api.k6.js` are synthetic test values. Run `node tools/performance/run-api.mjs`.

For standalone SFU tests, start a separate one-CPU `voixex-perf-livekit` container using the same server image but entrypoint `livekit-server`. Use an unused address on the private test network (the audit used `172.18.0.20`) as `rtc.node_ip`, disable external-IP discovery and bind ports 17880/17881/17882 inside the bridge. The runner expects test API key `perfkey` and secret `isolated-benchmark-livekit-secret`. Download/extract the official CLI into the path above and run `node tools/performance/run-livekit.mjs`. No external SFU service is used.

Then run `node tools/performance/run-extra.mjs`. Its observer mounts the local `voice-client` folder read-only; the output includes a short synthetic PCM WAV and the two-minute observer statistics. Wait for each matrix to finish before starting another CPU-heavy matrix on the same host.

## Calibration and collection

Run `core-cost.mjs` / `codec-cost.mjs` inside the pinned server image with `/bench` mounted read-only and a synthetic `TOKEN_SECRET`; do not mount `/data` or publish network ports. For optional Kubernetes calibration, create a separate temporary namespace/job with explicit node selection, CPU/memory requests and limits, no production labels, and no PVC mount. The audit used 600m on worker-2 and a short 200m job on worker-1; both were deleted. Do not apply those node names to another cluster without checking its available capacity.

Save component JSON outputs and the environment metadata before running:

```sh
python3 tools/performance/collect-results.py
python3 tools/performance/build-report.py
python3 tools/performance/plot-results.py
node primer_front/scripts/voice-worklet-check.mjs
```

The generated archive excludes exploratory pilots. `build-report.py` describes this specific audit; update its narrative as well as its tables for a new study. Never reuse its numbers as a new measurement.

## Focused 0.8.0 check

`node tools/performance/run-release-check.mjs` runs the bounded release matrix against local multiarch image `voixex-server:0.8.0-arm64`. It creates and removes its own private Docker network/target, uses no production data, and records results under `/tmp/voixex-performance/0.8.0`. `RELEASE_BENCH_IMAGE`, `RELEASE_BENCH_OUTPUT`, and `RELEASE_CASE_FILTER` override the image, output and selected cases. The gated cases import the actual client SilenceGate and supply known synthetic speech/zero RMS. Compile `voice-client` first. The 120-second observer case uses its real VoiceEngine.

## Cleanup

Only remove resources owned by this suite, after generators have finished:

```sh
docker rm -f voixex-perf-media voixex-perf-api voixex-perf-livekit
docker network rm voixex-perf-net
docker volume rm voixex-perf-api-data
```

Keep or remove `/tmp/voixex-performance` as desired after reviewing the results. Do not delete production volumes, namespaces or unrelated Docker resources. These scripts do not publish releases, push Docker tags, or update the production deployment.
