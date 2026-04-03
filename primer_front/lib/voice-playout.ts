/**
 * Jitter playout: accumulate network PCM blocks, then drain to the AudioWorklet on a
 * fixed cadence (~real-time). Pads with silence when the queue runs dry so the worklet
 * ring stays fed (avoids per-sample underrun storms and reduces audible gaps).
 *
 * Optional: initial hold (`startMs`) trades latency for stability under jitter.
 */
export type VoicePlayoutOptions = {
  /** Samples queued before timed drain begins (higher = more delay, fewer gaps). */
  startMs?: number
  /** How often we push audio to the worklet. */
  tickMs?: number
  /** Drop oldest audio if queue exceeds this (seconds) to cap end-to-end latency. */
  maxQueuedSec?: number
}

export class VoicePlayoutPrefetch {
  private queue = new Float32Array(0)
  private timer: ReturnType<typeof setInterval> | null = null
  private started = false
  private readonly sampleRate: number
  private readonly port: MessagePort
  private readonly startSamples: number
  private readonly samplesPerTick: number
  private readonly tickMs: number
  private readonly maxQueuedSamples: number

  constructor(sampleRate: number, port: MessagePort, opts: number | VoicePlayoutOptions = {}) {
    this.sampleRate = sampleRate
    this.port = port
    let startMs = 240
    let tickMs = 10
    let maxQueuedSec = 0.45
    if (typeof opts === "number") {
      startMs = opts
    } else {
      if (opts.startMs != null) startMs = opts.startMs
      if (opts.tickMs != null) tickMs = opts.tickMs
      if (opts.maxQueuedSec != null) maxQueuedSec = opts.maxQueuedSec
    }
    this.startSamples = Math.round((sampleRate * startMs) / 1000)
    this.tickMs = Math.max(4, tickMs)
    this.samplesPerTick = Math.max(128, Math.round((sampleRate * this.tickMs) / 1000))
    this.maxQueuedSamples = Math.max(this.startSamples * 2, Math.round(sampleRate * maxQueuedSec))
  }

  reset() {
    this.queue = new Float32Array(0)
    this.started = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  pushBlock(samples: Float32Array) {
    if (samples.length === 0) return
    const merged = new Float32Array(this.queue.length + samples.length)
    merged.set(this.queue, 0)
    merged.set(samples, this.queue.length)
    this.queue = merged
    if (this.queue.length > this.maxQueuedSamples) {
      const drop = this.queue.length - this.maxQueuedSamples
      this.queue = this.queue.subarray(drop)
    }
    if (!this.started && this.queue.length >= this.startSamples) {
      this.started = true
      this.tick()
      this.timer = setInterval(() => this.tick(), this.tickMs)
    }
  }

  private tick() {
    if (!this.started) return
    const n = this.samplesPerTick
    const chunk = new Float32Array(n)
    if (this.queue.length >= n) {
      chunk.set(this.queue.subarray(0, n))
      this.queue = this.queue.subarray(n)
    } else if (this.queue.length > 0) {
      chunk.set(this.queue)
      this.queue = new Float32Array(0)
    }
    this.postChunks(chunk)
  }

  private postChunks(data: Float32Array) {
    const maxChunk = 9600
    for (let i = 0; i < data.length; i += maxChunk) {
      const end = Math.min(i + maxChunk, data.length)
      const part = data.subarray(i, end)
      const copy = new Float32Array(part.length)
      copy.set(part)
      this.port.postMessage({ type: "push", data: copy }, [copy.buffer])
    }
  }
}

const VOICE_PLAYBACK_WORKLET_SOURCE = `
class VoicePlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    const cap = 48000 * 4
    this.buf = new Float32Array(cap)
    this.w = 0
    this.r = 0
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
        let free = L - 1 - this._used()
        let i = 0
        while (i < d.length) {
          if (free <= 0) {
            const drop = Math.min(64, this._used())
            this.r = (this.r + drop) % L
            this.overflowDrops += drop
            free = L - 1 - this._used()
          }
          const n = Math.min(d.length - i, free)
          for (let k = 0; k < n; k += 1) {
            this.buf[this.w] = d[i + k]
            this.w = (this.w + 1) % L
          }
          i += n
          free = L - 1 - this._used()
        }
      } else if (m.type === "reset") {
        this.w = 0
        this.r = 0
        this.underruns = 0
        this.overflowDrops = 0
        this.lastOut = 0
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
    const L = this.buf.length
    let hadUnderrun = false
    for (let i = 0; i < n; i += 1) {
      if (this.r === this.w) {
        hadUnderrun = true
        this.lastOut *= 0.985
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
