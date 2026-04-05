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
    let startMs = 180
    let maxQueuedSec = 0.9
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

const VOICE_CAPTURE_WORKLET_SOURCE = `
class VoiceCaptureFramerProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(8192)
    this.w = 0
    this.r = 0
    this.frameSize = 960
    this.port.onmessage = (e) => {
      const m = e.data
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
  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input || input.length === 0) return true
    for (let i = 0; i < input.length; i++) {
      this._push(input[i])
    }
    while (this._used() >= this.frameSize) {
      const out = new Float32Array(this.frameSize)
      for (let i = 0; i < this.frameSize; i++) {
        out[i] = this.buf[this.r]
        this.r = (this.r + 1) % this.buf.length
      }
      this.port.postMessage({ type: "frame", data: out }, [out.buffer])
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
