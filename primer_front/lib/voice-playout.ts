/**
 * Prefetch gate: accumulate ~targetMs of audio before streaming to the worklet,
 * then push each subsequent block. Reduces startup underruns under network jitter.
 */
export class VoicePlayoutPrefetch {
  private prefetch = new Float32Array(0)
  private started = false
  private readonly targetSamples: number

  constructor(
    sampleRate: number,
    private readonly port: MessagePort,
    targetMs = 80
  ) {
    this.targetSamples = Math.round((sampleRate * targetMs) / 1000)
  }

  reset() {
    this.prefetch = new Float32Array(0)
    this.started = false
  }

  pushBlock(samples: Float32Array) {
    if (samples.length === 0) return
    if (!this.started) {
      const merged = new Float32Array(this.prefetch.length + samples.length)
      merged.set(this.prefetch, 0)
      merged.set(samples, this.prefetch.length)
      if (merged.length < this.targetSamples) {
        this.prefetch = merged
        return
      }
      this.started = true
      this.postChunks(merged)
      this.prefetch = new Float32Array(0)
      return
    }
    this.postChunks(samples)
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
    for (let i = 0; i < n; i += 1) {
      if (this.r === this.w) {
        out[i] = 0
        this.underruns += 1
      } else {
        out[i] = this.buf[this.r]
        this.r = (this.r + 1) % L
      }
    }
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
