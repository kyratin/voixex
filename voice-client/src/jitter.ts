import { FRAME_MS, FRAME_SAMPLES, PCM_FRAME_BYTES } from "./protocol.js"

/** Minimal decoder surface (opusscript), injectable for tests. */
export type OpusDecoderLike = { decode(data: Buffer): Buffer }

export type StreamInput =
  /** Old clients: no frame numbers, ordered by packet seq; gaps in seq mean nothing (probes etc.). */
  | { mode: "legacy"; seq: number; codec: "pcm" | "opus"; data: Buffer; /** seq minus non-audio packets: the frame's slot in time. */ index: number }
  /** New clients: numbered frames; a missing number is a lost frame and gets concealed. */
  | { mode: "numbered"; frameNo: number; data: Buffer; primary: boolean; talkspurt: boolean }

export type StreamStats = {
  played: number
  concealed: number
  lateDrops: number
  catchupDrops: number
  hardDrops: number
  underruns: number
}

const MIN_TARGET = 2
const MAX_TARGET = 10
/** RMS below this counts as a pause, where dropping a frame to catch up is inaudible. */
const SILENCE_RMS = 0.012
/** Frames that may arrive this late after the last packet before a pause is assumed. */
const LATE_GRACE_MS = 70
const MAX_CONCEAL_RUN = 3
/** Frames of arrival history (2 s) used to size the buffer. */
const DELAY_WINDOW = 100

/**
 * Per-speaker adaptive jitter buffer in front of the room mixer.
 *
 * - Holds `target` frames (2–10, i.e. 40–200 ms) sized from the measured arrival jitter plus a
 *   boost after underruns, instead of the old fixed 3–4 frame queue that dropped audio on every
 *   burst and starved on every gap.
 * - Plays frames in order (Opus decoder state needs that) and conceals a missing frame with Opus
 *   PLC or a faded repeat.
 * - Catches up by skipping frames only during pauses, so a backlog never turns into a jump in
 *   the middle of a word; only a very large backlog is cut hard.
 */
export class SpeakerStream {
  private readonly pending = new Map<number, Buffer>()
  private codec: "pcm" | "opus" = "opus"
  private mode: "legacy" | "numbered" = "numbered"
  /** Legacy: keys (seq) in ascending order. */
  private legacyOrder: number[] = []
  private playing = false
  private nextFrameNo = 0
  private maxFrameNo = -1
  private lastPlayedSeq = -1
  private lastPushMs = 0
  private firstPendingAtMs = 0
  private lastArrivalMs = 0
  private lastArrivalKey = -1
  private jitterMs = 0
  /** arrival − frameIndex·20 ms for recent frames; its spread is the delay variation to absorb. */
  private readonly offsets = new Float64Array(DELAY_WINDOW)
  private offsetCount = 0
  private offsetPos = 0
  private delaySpreadMs = 0
  private boost = 0
  private lastBoostChangeMs = 0
  private concealRun = 0
  private lastPcm: Int16Array | null = null
  /** RMS (0..1) of the last frame handed to the mixer, for speaking detection. */
  lastRms = 0
  readonly stats: StreamStats = { played: 0, concealed: 0, lateDrops: 0, catchupDrops: 0, hardDrops: 0, underruns: 0 }

  constructor(private readonly decoder: () => OpusDecoderLike) {}

  /**
   * Enough buffer for 95 % of recent delay variation (+10 ms), plus a boost after underruns.
   * Mean-deviation jitter (RFC 3550) underestimates what reordering networks need.
   */
  get targetFrames() {
    const fromDelay = Math.ceil((this.delaySpreadMs + 10) / FRAME_MS)
    return Math.max(MIN_TARGET, Math.min(MAX_TARGET, fromDelay + this.boost))
  }

  get jitter() {
    return this.jitterMs
  }

  /** Frames currently waiting to be played. */
  get depthFrames() {
    if (this.mode === "legacy") return this.legacyOrder.length
    if (this.maxFrameNo < 0) return 0
    return this.playing ? Math.max(0, this.maxFrameNo - this.nextFrameNo + 1) : this.pending.size
  }

  push(input: StreamInput, nowMs: number) {
    if (input.mode !== this.mode) this.resetFor(input.mode)
    this.lastPushMs = nowMs
    if (input.mode === "legacy") {
      this.codec = input.codec
      if (input.seq <= this.lastPlayedSeq || this.pending.has(input.seq)) {
        this.stats.lateDrops += 1
        return
      }
      this.trackArrival(input.index, nowMs)
      if (this.pending.size === 0) this.firstPendingAtMs = nowMs
      this.pending.set(input.seq, input.data)
      // Mostly in order: insert from the back.
      let i = this.legacyOrder.length
      while (i > 0 && this.legacyOrder[i - 1] > input.seq) i -= 1
      this.legacyOrder.splice(i, 0, input.seq)
      return
    }

    this.codec = "opus"
    const key = input.frameNo
    if (this.playing && key < this.nextFrameNo) {
      if (input.primary) this.stats.lateDrops += 1
      return
    }
    if (this.pending.has(key)) return
    // A new talkspurt after a pause: play it from its first frame, not from where the last one ended.
    if (input.talkspurt && input.primary && this.playing && this.pending.size === 0 && key > this.nextFrameNo + MAX_TARGET) {
      this.playing = false
    }
    if (input.primary) this.trackArrival(key, nowMs)
    if (this.pending.size === 0) this.firstPendingAtMs = nowMs
    this.pending.set(key, input.data)
    if (key > this.maxFrameNo) this.maxFrameNo = key
  }

  /** One 20 ms frame for the mixer, or null when this speaker is silent. Call once per tick. */
  pull(nowMs: number): Int16Array | null {
    this.decayBoost(nowMs)
    if (!this.playing) {
      if (this.pending.size === 0) return null
      const waited = nowMs - this.firstPendingAtMs
      if (this.pending.size < this.targetFrames && waited < this.targetFrames * FRAME_MS + 20) return null
      this.playing = true
      this.concealRun = 0
      if (this.mode === "numbered") this.nextFrameNo = Math.min(...this.pending.keys())
    }
    const frame = this.mode === "legacy" ? this.pullLegacy(nowMs) : this.pullNumbered(nowMs)
    this.lastRms = frame ? rms(frame) : 0
    return frame
  }

  private pullNumbered(nowMs: number): Int16Array | null {
    const target = this.targetFrames
    // A backlog far beyond the target (e.g. after a stall) is cut at once.
    if (this.maxFrameNo - this.nextFrameNo + 1 > target + 12) {
      const resumeAt = this.maxFrameNo - target + 1
      for (const k of [...this.pending.keys()]) if (k < resumeAt) this.pending.delete(k)
      this.stats.hardDrops += resumeAt - this.nextFrameNo
      this.nextFrameNo = resumeAt
    }
    let data = this.pending.get(this.nextFrameNo)
    if (data) {
      this.pending.delete(this.nextFrameNo)
      this.nextFrameNo += 1
      let pcm = this.decode(data)
      // Over target: drop a quiet frame (a pause) to bring latency back down.
      const depth = this.maxFrameNo - this.nextFrameNo + 1
      const next = this.pending.get(this.nextFrameNo)
      if (depth > target + 1 && next && rms(pcm) < SILENCE_RMS) {
        this.pending.delete(this.nextFrameNo)
        this.nextFrameNo += 1
        pcm = this.decode(next)
        this.stats.catchupDrops += 1
      }
      return this.played(pcm)
    }
    // The next frame is missing.
    const laterFramesWaiting = this.pending.size > 0
    if (laterFramesWaiting || (nowMs - this.lastPushMs < LATE_GRACE_MS && this.concealRun < MAX_CONCEAL_RUN)) {
      if (!laterFramesWaiting) this.noteUnderrun(nowMs)
      this.nextFrameNo += 1
      return this.conceal()
    }
    this.stop()
    return null
  }

  private pullLegacy(nowMs: number): Int16Array | null {
    const key = this.legacyOrder.shift()
    if (key !== undefined) {
      const data = this.pending.get(key)!
      this.pending.delete(key)
      this.lastPlayedSeq = key
      let pcm = this.decode(data)
      const target = this.targetFrames
      if (this.legacyOrder.length > target + 12) {
        const drop = this.legacyOrder.length - target
        for (const k of this.legacyOrder.splice(0, drop)) {
          this.pending.delete(k)
          this.lastPlayedSeq = k
        }
        this.stats.hardDrops += drop
      } else if (this.legacyOrder.length > target + 1 && rms(pcm) < SILENCE_RMS) {
        const k = this.legacyOrder.shift()!
        pcm = this.decode(this.pending.get(k)!)
        this.pending.delete(k)
        this.lastPlayedSeq = k
        this.stats.catchupDrops += 1
      }
      return this.played(pcm)
    }
    if (nowMs - this.lastPushMs < LATE_GRACE_MS && this.concealRun < MAX_CONCEAL_RUN) {
      this.noteUnderrun(nowMs)
      return this.conceal()
    }
    this.stop()
    return null
  }

  private played(pcm: Int16Array) {
    this.concealRun = 0
    this.lastPcm = pcm
    this.stats.played += 1
    return pcm
  }

  private conceal(): Int16Array {
    this.concealRun += 1
    this.stats.concealed += 1
    const fade = this.concealRun === 1 ? 1 : this.concealRun === 2 ? 0.6 : 0.3
    let base: Int16Array | null = null
    if (this.codec === "opus") {
      try {
        // Opus: an empty packet asks the decoder for packet-loss concealment.
        base = toFrame(this.decoder().decode(Buffer.alloc(0)))
      } catch {
        base = null
      }
    }
    base ??= this.lastPcm ?? new Int16Array(FRAME_SAMPLES)
    const out = new Int16Array(FRAME_SAMPLES)
    for (let i = 0; i < FRAME_SAMPLES; i += 1) out[i] = Math.round(base[i] * fade)
    this.lastPcm = out
    return out
  }

  private decode(data: Buffer): Int16Array {
    if (this.codec === "pcm") return toFrame(data)
    try {
      return toFrame(this.decoder().decode(data))
    } catch {
      return this.conceal()
    }
  }

  private stop() {
    this.playing = false
    this.concealRun = 0
    this.lastPcm = null
    this.pending.clear()
    this.legacyOrder = []
    this.maxFrameNo = -1
  }

  private resetFor(mode: "legacy" | "numbered") {
    this.stop()
    this.mode = mode
    this.lastPlayedSeq = -1
    this.lastArrivalKey = -1
  }

  private trackArrival(key: number, nowMs: number) {
    const framesSinceLast = key - this.lastArrivalKey
    const continuous = this.lastArrivalKey >= 0 && Math.abs(framesSinceLast) < 50 && nowMs - this.lastArrivalMs < 1000
    if (!continuous) this.offsetCount = 0
    // RFC 3550 interarrival jitter, kept for stats.
    if (continuous && framesSinceLast > 0) {
      const d = Math.abs(nowMs - this.lastArrivalMs - framesSinceLast * FRAME_MS)
      this.jitterMs += (d - this.jitterMs) / 16
    }
    if (key >= this.lastArrivalKey || !continuous) {
      this.lastArrivalKey = key
      this.lastArrivalMs = nowMs
    }
    this.offsets[this.offsetPos] = nowMs - key * FRAME_MS
    this.offsetPos = (this.offsetPos + 1) % DELAY_WINDOW
    this.offsetCount = Math.min(DELAY_WINDOW, this.offsetCount + 1)
    if (this.offsetCount >= 5) {
      const recent: number[] = []
      for (let i = 0; i < this.offsetCount; i += 1) recent.push(this.offsets[(this.offsetPos - 1 - i + DELAY_WINDOW) % DELAY_WINDOW])
      recent.sort((a, b) => a - b)
      this.delaySpreadMs = recent[Math.floor((recent.length - 1) * 0.95)] - recent[0]
    }
  }

  private noteUnderrun(nowMs: number) {
    this.stats.underruns += 1
    if (this.boost < 4 && nowMs - this.lastBoostChangeMs > 500) {
      this.boost += 1
      this.lastBoostChangeMs = nowMs
    }
  }

  private decayBoost(nowMs: number) {
    if (this.boost > 0 && nowMs - this.lastBoostChangeMs > 10_000) {
      this.boost -= 1
      this.lastBoostChangeMs = nowMs
    }
  }
}

/** Copy into an aligned 20 ms frame (decoders reuse and may misalign their buffers). */
export function toFrame(buf: Buffer): Int16Array {
  const out = new Int16Array(FRAME_SAMPLES)
  const bytes = Math.min(buf.length, PCM_FRAME_BYTES) & ~1
  Buffer.from(out.buffer).set(buf.subarray(0, bytes))
  return out
}

export function rms(frame: Int16Array) {
  let sum = 0
  for (let i = 0; i < frame.length; i += 1) {
    const v = frame[i] / 32768
    sum += v * v
  }
  return Math.sqrt(sum / Math.max(1, frame.length))
}
