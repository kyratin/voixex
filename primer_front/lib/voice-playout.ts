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

export class VoiceCaptureFramer {
  private readonly port: MessagePort
  constructor(port: MessagePort) {
    this.port = port
  }
  reset() {
    this.port.postMessage({ type: "reset" })
  }
}

export class VoicePlayoutPrefetch {
  private readonly port: MessagePort
  private readonly sampleRate: number

  constructor(sampleRate: number, port: MessagePort, opts: number | VoicePlayoutOptions = {}) {
    this.port = port
    this.sampleRate = sampleRate
    let startMs = 60
    let maxQueuedSec = 0.4
    if (typeof opts === "number") {
      startMs = opts
    } else {
      if (opts.startMs != null) startMs = opts.startMs
      if (opts.maxQueuedSec != null) maxQueuedSec = opts.maxQueuedSec
    }
    this.reconfigure(startMs, maxQueuedSec)
  }

  reset() {
    this.port.postMessage({ type: "reset" })
  }

  reconfigure(startMs: number, maxQueuedSec: number) {
    const startThreshold = Math.max(1, Math.round((this.sampleRate * startMs) / 1000))
    const maxBuffered = Math.max(startThreshold * 2, Math.round(this.sampleRate * maxQueuedSec))
    this.port.postMessage({ type: "configure", startThreshold, maxBuffered })
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
    this.catchupDrops = 0
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
          // Far behind (e.g. after the app was frozen): jump to the target at once.
          const drop = used - this.startThreshold
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
        this.catchupDrops = 0
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
        continue
      }
      let s = this.buf[this.r]
      this.r = (this.r + 1) % L
      this.lastOut = s
      out[i] = s
    }
    if (hadUnderrun) {
      this.underruns += 1
      // Ran dry: wait for the target amount again instead of stuttering on every late packet.
      this.started = false
    }
    this._tick += 1
    if (this._tick >= 375) {
      this._tick = 0
      this.port.postMessage({
        type: "stats",
        bufferedSamples: this._used(),
        underruns: this.underruns,
        overflowDrops: this.overflowDrops + this.catchupDrops
      })
    }
    return true
  }
}
registerProcessor("voice-playback", VoicePlaybackProcessor)
`

const VOICE_CAPTURE_WORKLET_SOURCE = `
class VoiceCaptureFramerProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(8192)
    this.w = 0
    this.r = 0
    this.frameSize = 960
    this.gate = null
    this.env = 0
    this.gain = 1
    this.zone = "open"
    this.port.onmessage = (e) => {
      const m = e.data
      if (m.type === "gate") this.gate = m.enabled ? m : null
      if (m.type === "reset") {
        this.w = 0
        this.r = 0
      }
    }
  }
  _used() {
    const L = this.buf.length
    if (this.w >= this.r) return this.w - this.r
    return L - this.r + this.w
  }
  _push(v) {
    const L = this.buf.length
    this.buf[this.w] = v
    this.w = (this.w + 1) % L
    if (this.w === this.r) {
      this.r = (this.r + 1) % L
    }
  }
  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input || input.length === 0) return true
    // Keep the processed microphone path on the audio thread (LiveKit and monitoring).
    const output = outputs[0] && outputs[0][0]
    const g = this.gate
    const muteT = g ? Math.max(8, g.muteThreshold) : 0
    const openT = g ? Math.max(muteT + 24, g.openThreshold) : 0
    const release = Math.exp(-1 / (sampleRate * ((g ? Math.max(80, g.releaseMs) : 80) / 1000)))
    const attack = Math.exp(-1 / (sampleRate * 0.004))
    const up = Math.exp(-1 / (sampleRate * 0.003))
    const down = Math.exp(-1 / (sampleRate * 0.012))
    for (let i = 0; i < input.length; i++) {
      let s = input[i]
      if (g) {
        const p = Math.abs(s * 32768)
        this.env = p >= this.env ? this.env + (p - this.env) * (1 - attack) : this.env * release
        if (this.zone === "open") {
          if (this.env < openT * 0.9) this.zone = this.env >= muteT ? "duck" : "mute"
        } else if (this.zone === "duck") {
          if (this.env >= openT) this.zone = "open"
          else if (this.env < muteT * 0.88) this.zone = "mute"
        } else this.zone = this.env >= openT ? "open" : this.env >= muteT ? "duck" : "mute"
        const target = this.zone === "open" ? 1 : this.zone === "duck" ? Math.max(0.01, Math.min(0.5, g.floorRatio)) : 0
        this.gain += (target - this.gain) * (1 - (target > this.gain ? up : down))
        s *= this.gain
      }
      if (output) output[i] = s
      this._push(s)
    }
    while (this._used() >= this.frameSize) {
      const out = new Float32Array(this.frameSize)
      for (let i = 0; i < this.frameSize; i++) {
        out[i] = this.buf[this.r]
        this.r = (this.r + 1) % this.buf.length
      }
      this.port.postMessage({ type: "frame", data: out, capturedAt: currentTime }, [out.buffer])
    }
    return true
  }
}
registerProcessor("voice-capture-framer", VoiceCaptureFramerProcessor)
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

export async function loadVoiceCaptureWorklet(ctx: AudioContext): Promise<AudioWorkletNode> {
  const blob = new Blob([VOICE_CAPTURE_WORKLET_SOURCE], { type: "application/javascript" })
  const blobUrl = URL.createObjectURL(blob)
  try {
    await ctx.audioWorklet.addModule(blobUrl)
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
  return new AudioWorkletNode(ctx, "voice-capture-framer", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers"
  })
}
