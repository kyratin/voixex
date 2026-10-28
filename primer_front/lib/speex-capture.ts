import type { RnnoiseWorkletNode, SpeexWorkletNode } from "@sapphi-red/web-noise-suppressor"

/**
 * SpeexDSP preprocess (noise suppression) in an AudioWorklet. Assets live in /public
 * (speex.wasm, speex-worklet.js) so Next static export and Electron file:// resolve them.
 *
 * Dynamic import keeps `@sapphi-red/web-noise-suppressor` (AudioWorkletNode) off the SSR bundle.
 */
export async function createSpeexNoiseWorklet(ctx: AudioContext): Promise<SpeexWorkletNode> {
  const { SpeexWorkletNode: SpeexCtor, loadSpeex } = await import("@sapphi-red/web-noise-suppressor")
  const wasmUrl = new URL("speex.wasm", window.location.href).href
  const workletUrl = new URL("speex-worklet.js", window.location.href).href
  const wasmBinary = await loadSpeex({ url: wasmUrl })
  await ctx.audioWorklet.addModule(workletUrl)
  return new SpeexCtor(ctx, { maxChannels: 1, wasmBinary })
}

/**
 * AI noise suppression: RNNoise (a small recurrent neural network trained to separate speech from
 * noise — keyboard, fans, traffic) in an AudioWorklet, entirely on the device. Needs a 48 kHz
 * context. The SIMD build is used where the CPU supports it.
 */
export async function createRnnoiseWorklet(ctx: AudioContext): Promise<RnnoiseWorkletNode> {
  const { RnnoiseWorkletNode: RnnoiseCtor, loadRnnoise } = await import("@sapphi-red/web-noise-suppressor")
  const wasmBinary = await loadRnnoise({
    url: new URL("rnnoise.wasm", window.location.href).href,
    simdUrl: new URL("rnnoise_simd.wasm", window.location.href).href
  })
  await ctx.audioWorklet.addModule(new URL("rnnoise-worklet.js", window.location.href).href)
  return new RnnoiseCtor(ctx, { maxChannels: 1, wasmBinary })
}

/** MediaStreamDestination defaults to stereo; duplicate mono to L+R so playback is centered. */
export type MonoMediaStreamTap = {
  destination: MediaStreamAudioDestinationNode
  merger: ChannelMergerNode
}

export function createMonoMediaStreamTap(ctx: AudioContext): MonoMediaStreamTap {
  const destination = ctx.createMediaStreamDestination()
  const merger = ctx.createChannelMerger(2)
  merger.connect(destination)
  return { destination, merger }
}

export function connectMonoSourceToTap(source: AudioNode, tap: MonoMediaStreamTap) {
  source.connect(tap.merger, 0, 0)
  source.connect(tap.merger, 0, 1)
}
