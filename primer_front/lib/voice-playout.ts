/**
 * Voice playout: network PCM → AudioWorklet ring-buffer → speakers.
 *
 * Previous design used a JS-side queue + setInterval drain, which caused
 * timing jitter (±5 ms on macOS) → underruns / pitch-jumps. Now audio goes
 * straight to the worklet via postMessage; the worklet handles initial
 * buffering, overflow trimming, and underrun fade-out on the audio thread.
 */
export type VoicePlayoutOptions = {
  /** ms of audio to buffer before the worklet starts reading (trades latency for stability). */
  startMs?: number
  /** Drop oldest audio when the ring exceeds this many seconds (caps end-to-end latency). */
  maxQueuedSec?: number
}

export class VoicePlayoutPrefetch {
  private readonly port: MessagePort

  constructor(sampleRate: number, port: MessagePort, opts: number | VoicePlayoutOptions = {}) {
    this.port = port
    let startMs = 120
    let maxQueuedSec = 0.5
    if (typeof opts === "number") {
      startMs = opts
    } else {
      if (opts.startMs != null) startMs = opts.startMs
      if (opts.maxQueuedSec != null) maxQueuedSec = opts.maxQueuedSec
    }
    const startThreshold = Math.max(1, Math.round((sampleRate * startMs) / 1000))
    const maxBuffered = Math.max(startThreshold * 2, Math.round(sampleRate * maxQueuedSec))
    port.postMessage({ type: "configure", startThreshold, maxBuffered })
  }

  reset() {
    this.port.postMessage({ type: "reset" })
  }

  pushBlock(samples: Float32Array) {
    if (samples.length === 0) return
    const maxChunk = 9600
    for (let i = 0; i < samples.length; i += maxChunk) {
      const end = Math.min(i + maxChunk, samples.length)
      const copy = new Float32Array(end - i)
      copy.set(samples.subarray(i, end))
      this.port.postMessage({ type: "push", data: copy }, [copy.buffer])
    }
  }
}

const VOICE_PLAYBACK_WORKLET_SOURCE = `
class VoicePlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    const cap = 48000 * 2
    this.buf = new Float32Array(cap)
    this.w = 0
    this.r = 0
    this.started = false
    this.startThreshold = Math.round(48000 * 0.12)
    this.maxBuffered = Math.round(48000 * 0.5)
    this.underruns = 0
    this.overflowDrops = 0
    this._tick = 0
    this.lastOut = 0
    this.port.onmessage = (e) => {
      const m = e.data
      if (m.type === "push") {
        const d = m.data
        if (!d || !d.length) return
        const L = this.buf.length
        for (let i = 0; i < d.length; i++) {
          this.buf[this.w] = d[i]
          this.w = (this.w + 1) % L
        }
        const used = this._used()
        if (used > this.maxBuffered) {
          const drop = used - this.maxBuffered
          this.r = (this.r + drop) % L
          this.overflowDrops += drop
        }
        if (!this.started && this._used() >= this.startThreshold) {
          this.started = true
        }
      } else if (m.type === "reset") {
        this.w = 0
        this.r = 0
        this.started = false
        this.underruns = 0
        this.overflowDrops = 0
        this.lastOut = 0
      } else if (m.type === "configure") {
        if (typeof m.startThreshold === "number") this.startThreshold = m.startThreshold
        if (typeof m.maxBuffered === "number") this.maxBuffered = m.maxBuffered
      }
    }
  }
  _used() {
    const L = this.buf.length
    if (this.w >= this.r) return this.w - this.r
    return L - this.r + this.w
  }
  process(inputs, outputs) {
    const out = outputs[0][0]
    const n = out.length
    if (!this.started) {
      for (let i = 0; i < n; i++) out[i] = 0
      return true
    }
    const L = this.buf.length
    let hadUnderrun = false
    for (let i = 0; i < n; i++) {
      if (this.r === this.w) {
        hadUnderrun = true
        this.lastOut *= 0.97
        out[i] = this.lastOut
      } else {
        const s = this.buf[this.r]
        this.r = (this.r + 1) % L
        this.lastOut = s
        out[i] = s
      }
    }
    if (hadUnderrun) this.underruns += 1
    this._tick += 1
    if (this._tick >= 375) {
      this._tick = 0
      this.port.postMessage({
        type: "stats",
        bufferedSamples: this._used(),
        underruns: this.underruns,
        overflowDrops: this.overflowDrops
      })
    }
    return true
  }
}
registerProcessor("voice-playback", VoicePlaybackProcessor)
`

export async function loadVoicePlaybackWorklet(ctx: AudioContext): Promise<AudioWorkletNode> {
  const blob = new Blob([VOICE_PLAYBACK_WORKLET_SOURCE], { type: "application/javascript" })
  const blobUrl = URL.createObjectURL(blob)
  try {
    await ctx.audioWorklet.addModule(blobUrl)
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
  return new AudioWorkletNode(ctx, "voice-playback", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1]
  })
}
