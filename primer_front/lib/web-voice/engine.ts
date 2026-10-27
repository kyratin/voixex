import {
  FRAME_MS,
  FRAME_SAMPLES,
  KIND_OPUS2,
  KIND_PCM,
  KIND_PROBE,
  KIND_PROBE_ACK,
  OPUS2_FLAG_TALKSPURT,
  SAMPLE_RATE,
  bytesOf,
  decodeOpus2,
  decodeProbe,
  decryptPacket,
  deriveMediaKey,
  encodeOpus2,
  encodeProbe,
  encryptPacket,
  textOf
} from "./protocol"

const BITRATE_GOOD = 32_000
const BITRATE_LOSSY = 24_000
const BITRATE_BAD = 16_000
/** No captured frame for this long starts a new talkspurt (mute, gate). */
const SEND_GAP_MS = 80
const WS_MAX_BACKLOG = 24 * 1024
const MIN_TARGET = 2
const MAX_TARGET = 10
const DELAY_WINDOW = 100
const LATE_GRACE_MS = 70
const MAX_CONCEAL_RUN = 3

export type WebVoiceStats = {
  connected: boolean
  transport: "ws"
  codec: "opus"
  muted: boolean
  deafened: boolean
  roomId: string | null
  txPackets: number
  rxPackets: number
  packetLossPct: number
  uplinkLossPct: number
  uplinkBitrate: number
  pingNowMs: number
  ping1PctMs: number
  jitterNowMs: number
  jitter1PctMs: number
  jitterBufferMs: number
  concealedFrames: number
  /** How the microphone goes out: Opus via WebCodecs, raw PCM when the WebView cannot encode Opus. */
  uplinkCodec: "opus" | "pcm" | "pending"
  captureFrames: number
  uplinkError: string | null
}

/**
 * Voice engine for clients without UDP/TCP sockets (Android WebView, browsers): the opus2 media
 * protocol over a WebSocket to /v1/media/ws, Opus via WebCodecs. Same mixer and rooms as the
 * desktop engine, so phones and desktops hear each other.
 *
 * PCM in and out is 20 ms of 48 kHz mono Int16, like the desktop bridge.
 */
export class WebVoiceEngine {
  private ws: WebSocket | null = null
  private key: CryptoKey | null = null
  private wsUrl = ""
  private mediaToken = ""
  private connected = false
  private closing = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private roomId: string | null = null
  private muted = false
  private deafened = false
  private seqOut = 1
  private onPcm: ((pcm: Int16Array) => void) | null = null

  // uplink
  private encoder: AudioEncoder | null = null
  /** Decided once per connection by probing WebCodecs (see prepareUplink). */
  private uplinkCodec: "opus" | "pcm" | "pending" = "pending"
  private uplinkConfig: AudioEncoderConfig | null = null
  private uplinkError: string | null = null
  private captureFrames = 0
  private bitrate = BITRATE_GOOD
  private txFrameNo = 0
  private lastSendMs = 0
  private pendingFlags = new Map<number, number>()
  private uplinkLossPct = 0

  // downlink (reorder buffer → decoder → output in order)
  private decoder: AudioDecoder | null = null
  private pending = new Map<number, Uint8Array>()
  private playing = false
  private nextFrameNo = 0
  private maxFrameNo = -1
  private lastPushMs = 0
  private firstPendingAtMs = 0
  private concealRun = 0
  /** Output order: "d" waits for the decoder, "g" is a concealed gap. */
  private slots: Array<"d" | "g"> = []
  private lastPcm: Int16Array | null = null
  private offsets = new Float64Array(DELAY_WINDOW)
  private offsetCount = 0
  private offsetPos = 0
  private delaySpreadMs = 0
  private lastArrivalKey = -1
  private lastArrivalMs = 0
  private jitterMs = 0
  private boost = 0
  private lastBoostChangeMs = 0
  private clockTimer: ReturnType<typeof setTimeout> | null = null
  private probeTimer: ReturnType<typeof setInterval> | null = null
  private rxLoss = { expected: 0, received: 0, highest: -1 }

  // stats
  private txPackets = 0
  private rxPackets = 0
  private concealed = 0
  private rttMs = 0
  private rttSamples: number[] = []
  private jitterSamples: number[] = []

  static supported() {
    return typeof AudioEncoder !== "undefined" && typeof AudioDecoder !== "undefined" && typeof WebSocket !== "undefined"
  }

  setOnPcm(listener: ((pcm: Int16Array) => void) | null) {
    this.onPcm = listener
  }

  async connect(input: { apiBase: string; mediaToken: string }) {
    this.close()
    this.closing = false
    this.mediaToken = input.mediaToken
    this.wsUrl = `${input.apiBase.replace(/^http/, "ws").replace(/\/+$/, "")}/v1/media/ws`
    this.key = await deriveMediaKey(mediaSeedOf(input.mediaToken))
    await this.open()
    await this.prepareUplink()
    this.connected = true
    this.startClock()
    this.probeTimer = setInterval(() => void this.sendProbe(), 1000)
  }

  private open() {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl)
      ws.binaryType = "arraybuffer"
      this.ws = ws
      const timer = setTimeout(() => {
        reject(new Error("Voice connection timed out"))
        ws.close()
      }, 6000)
      ws.onopen = () => ws.send(bytesOf(`HELLO2 ${this.mediaToken} opus2`))
      ws.onmessage = (event) => {
        const data = new Uint8Array(event.data as ArrayBuffer)
        if (data.length < 32 && data[0] === 0x48 /* H */) {
          const text = textOf(data)
          if (text.startsWith("HELLO_ACK")) {
            clearTimeout(timer)
            resolve()
          } else if (text === "HELLO_FAIL") {
            clearTimeout(timer)
            reject(new Error("Voice connection rejected by the server"))
          }
          return
        }
        void this.onPacket(data)
      }
      ws.onclose = () => {
        clearTimeout(timer)
        if (this.ws !== ws) return
        this.ws = null
        reject(new Error("Voice connection closed"))
        // Phones switch networks; come back on our own while the call is up.
        if (this.connected && !this.closing) this.scheduleReconnect()
      }
    })
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.open().catch(() => this.scheduleReconnect())
    }, 1500)
  }

  joinRoom(roomId: string) {
    if (this.roomId !== roomId) this.resetDownlink()
    this.roomId = roomId
    this.lastSendMs = 0
  }

  leaveRoom() {
    this.roomId = null
    this.resetDownlink()
  }

  setMute(muted: boolean) {
    this.muted = muted
  }

  setDeafen(deafened: boolean) {
    this.deafened = deafened
  }

  close() {
    this.closing = true
    this.connected = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.clockTimer) clearTimeout(this.clockTimer)
    if (this.probeTimer) clearInterval(this.probeTimer)
    this.reconnectTimer = null
    this.clockTimer = null
    this.probeTimer = null
    this.ws?.close()
    this.ws = null
    for (const c of [this.encoder, this.decoder]) {
      try {
        if (c && c.state !== "closed") c.close()
      } catch {
        /* already closed */
      }
    }
    this.encoder = null
    this.decoder = null
    this.uplinkCodec = "pending"
    this.resetDownlink()
  }

  /** One 20 ms frame from the microphone. */
  sendPcm16(frame: Int16Array) {
    if (!this.connected || !this.roomId || this.muted || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const now = performance.now()
    let flags = 0
    if (this.lastSendMs === 0 || now - this.lastSendMs > SEND_GAP_MS) {
      if (this.lastSendMs > 0) this.txFrameNo += Math.max(1, Math.round((now - this.lastSendMs) / FRAME_MS)) - 1
      flags = OPUS2_FLAG_TALKSPURT
    }
    this.lastSendMs = now
    const frameNo = this.txFrameNo++
    this.captureFrames += 1
    if (this.uplinkCodec === "pcm") {
      // No Opus encoder in this WebView: raw 48 kHz PCM (the server accepts it from any client).
      void this.send(KIND_PCM, new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength).slice())
      return
    }
    if (this.uplinkCodec !== "opus") return
    this.pendingFlags.set(frameNo, flags)
    const f32 = new Float32Array(FRAME_SAMPLES)
    for (let i = 0; i < FRAME_SAMPLES; i += 1) f32[i] = (frame[i] ?? 0) / 32768
    const encoder = this.getEncoder()
    if (!encoder) return
    const data = new AudioData({
      format: "f32",
      sampleRate: SAMPLE_RATE,
      numberOfFrames: FRAME_SAMPLES,
      numberOfChannels: 1,
      timestamp: frameNo * FRAME_MS * 1000,
      data: f32
    })
    try {
      encoder.encode(data)
    } catch (e) {
      this.failOpus(e)
    } finally {
      data.close()
    }
  }

  /**
   * Picks the uplink codec: the full Opus config, a minimal one, or raw PCM. Android WebViews
   * differ in what WebCodecs accepts, and a rejected config used to fail silently (no audio out).
   */
  private async prepareUplink() {
    if (this.uplinkCodec !== "pending") return
    const base = { codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1 }
    const candidates: AudioEncoderConfig[] = [
      { ...base, bitrate: this.bitrate, opus: { frameDuration: FRAME_MS * 1000, complexity: 5, format: "opus" } } as AudioEncoderConfig,
      { ...base, bitrate: this.bitrate } as AudioEncoderConfig,
      base as AudioEncoderConfig
    ]
    if (typeof AudioEncoder !== "undefined" && typeof AudioData !== "undefined") {
      for (const config of candidates) {
        try {
          const support = await AudioEncoder.isConfigSupported(config)
          if (support.supported) {
            this.uplinkConfig = config
            this.uplinkCodec = "opus"
            return
          }
        } catch (e) {
          this.uplinkError = String(e)
        }
      }
      this.uplinkError ??= "Opus encoding is not supported by this WebView"
    } else {
      this.uplinkError = "WebCodecs AudioEncoder is unavailable"
    }
    this.uplinkCodec = "pcm"
  }

  private failOpus(e: unknown) {
    this.uplinkError = e instanceof Error ? e.message : String(e)
    this.uplinkCodec = "pcm"
    try {
      if (this.encoder && this.encoder.state !== "closed") this.encoder.close()
    } catch {
      /* already closed */
    }
    this.encoder = null
  }

  getStats(): WebVoiceStats {
    const exp = this.rxLoss.expected
    return {
      connected: this.connected && this.ws?.readyState === WebSocket.OPEN,
      transport: "ws",
      codec: "opus",
      muted: this.muted,
      deafened: this.deafened,
      roomId: this.roomId,
      txPackets: this.txPackets,
      rxPackets: this.rxPackets,
      packetLossPct: exp > 0 ? (Math.max(0, exp - this.rxLoss.received) * 100) / exp : 0,
      uplinkLossPct: this.uplinkLossPct,
      uplinkBitrate: this.bitrate,
      pingNowMs: this.rttMs,
      ping1PctMs: percentile(this.rttSamples, 0.99),
      jitterNowMs: Number(this.jitterMs.toFixed(2)),
      jitter1PctMs: percentile(this.jitterSamples, 0.99),
      jitterBufferMs: this.targetFrames * FRAME_MS,
      concealedFrames: this.concealed,
      uplinkCodec: this.uplinkCodec,
      captureFrames: this.captureFrames,
      uplinkError: this.uplinkError
    }
  }

  private getEncoder() {
    if (this.encoder && this.encoder.state !== "closed") return this.encoder
    try {
      const enc = new AudioEncoder({
        output: (chunk) => this.onEncoded(chunk),
        // An encoder that errors out once (e.g. a config the platform rejects late) is not retried.
        error: (e) => this.failOpus(e)
      })
      enc.configure(this.encoderConfig())
      this.encoder = enc
      return enc
    } catch (e) {
      this.failOpus(e)
      return null
    }
  }

  private encoderConfig(): AudioEncoderConfig {
    const config = this.uplinkConfig ?? ({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1 } as AudioEncoderConfig)
    return "bitrate" in config ? { ...config, bitrate: this.bitrate } : config
  }

  private onEncoded(chunk: EncodedAudioChunk) {
    const frameNo = Math.round(chunk.timestamp / (FRAME_MS * 1000))
    const flags = this.pendingFlags.get(frameNo) ?? 0
    this.pendingFlags.delete(frameNo)
    const data = new Uint8Array(chunk.byteLength)
    chunk.copyTo(data)
    // WebSocket is reliable: no redundant copies.
    void this.send(KIND_OPUS2, encodeOpus2(frameNo, flags, [data]))
  }

  private async send(kind: number, payload: Uint8Array, control = false) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.key) return
    if (!control && ws.bufferedAmount > WS_MAX_BACKLOG) return
    const packet = await encryptPacket(this.key, this.seqOut++, Date.now(), this.roomId ?? "", payload, kind)
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(packet)
    this.txPackets += 1
  }

  private async sendProbe() {
    const exp = this.rxLoss.expected
    const lossPct = exp > 0 ? (Math.max(0, exp - this.rxLoss.received) * 100) / exp : 0
    this.rxLoss = { expected: 0, received: 0, highest: this.rxLoss.highest }
    await this.send(KIND_PROBE, encodeProbe(Date.now() >>> 0, { lossPermille: lossPct * 10, jitterMs: this.jitterMs, bufferMs: this.targetFrames * FRAME_MS }), true)
  }

  private async onPacket(data: Uint8Array) {
    if (!this.key) return
    const packet = await decryptPacket(this.key, data)
    if (!packet) return
    this.rxPackets += 1
    if (packet.kind === KIND_PROBE_ACK) {
      const ack = decodeProbe(packet.payload)
      if (!ack) return
      const rtt = ((Date.now() >>> 0) - ack.clientMs) | 0
      if (rtt >= 0 && rtt < 10_000) {
        this.rttMs = rtt
        pushSample(this.rttSamples, rtt, 300)
      }
      this.adaptUplink(ack.report.lossPermille / 10)
      return
    }
    if (packet.kind !== KIND_OPUS2) return
    const opus = decodeOpus2(packet.payload)
    if (!opus) return
    const now = performance.now()
    const primary = opus.frames[0].frameNo
    const loss = this.rxLoss
    if (primary > loss.highest) {
      const step = primary - loss.highest
      loss.expected += loss.highest < 0 || step >= 25 ? 1 : step
      loss.highest = primary
    }
    loss.received += 1
    opus.frames.forEach((f, i) => this.pushFrame(f.frameNo, f.data, i === 0, i === 0 && (opus.flags & OPUS2_FLAG_TALKSPURT) !== 0, now))
  }

  private adaptUplink(lossPct: number) {
    this.uplinkLossPct = lossPct
    const bitrate = lossPct > 10 ? BITRATE_BAD : lossPct > 3 ? BITRATE_LOSSY : BITRATE_GOOD
    if (bitrate === this.bitrate) return
    this.bitrate = bitrate
    try {
      this.encoder?.configure(this.encoderConfig())
    } catch {
      this.encoder = null
    }
  }

  // ---- downlink jitter buffer ----

  private get targetFrames() {
    const fromDelay = Math.ceil((this.delaySpreadMs + 10) / FRAME_MS)
    return Math.max(MIN_TARGET, Math.min(MAX_TARGET, fromDelay + this.boost))
  }

  private pushFrame(frameNo: number, data: Uint8Array, primary: boolean, talkspurt: boolean, now: number) {
    this.lastPushMs = now
    if (this.playing && frameNo < this.nextFrameNo) return
    if (this.pending.has(frameNo)) return
    if (talkspurt && primary && this.playing && this.pending.size === 0 && frameNo > this.nextFrameNo + MAX_TARGET) this.playing = false
    if (primary) this.trackArrival(frameNo, now)
    if (this.pending.size === 0) this.firstPendingAtMs = now
    this.pending.set(frameNo, data)
    if (frameNo > this.maxFrameNo) this.maxFrameNo = frameNo
  }

  private trackArrival(key: number, now: number) {
    const since = key - this.lastArrivalKey
    const continuous = this.lastArrivalKey >= 0 && Math.abs(since) < 50 && now - this.lastArrivalMs < 1000
    if (!continuous) this.offsetCount = 0
    if (continuous && since > 0) {
      this.jitterMs += (Math.abs(now - this.lastArrivalMs - since * FRAME_MS) - this.jitterMs) / 16
      pushSample(this.jitterSamples, this.jitterMs)
    }
    if (key >= this.lastArrivalKey || !continuous) {
      this.lastArrivalKey = key
      this.lastArrivalMs = now
    }
    this.offsets[this.offsetPos] = now - key * FRAME_MS
    this.offsetPos = (this.offsetPos + 1) % DELAY_WINDOW
    this.offsetCount = Math.min(DELAY_WINDOW, this.offsetCount + 1)
    if (this.offsetCount >= 5) {
      const recent: number[] = []
      for (let i = 0; i < this.offsetCount; i += 1) recent.push(this.offsets[(this.offsetPos - 1 - i + DELAY_WINDOW) % DELAY_WINDOW])
      recent.sort((a, b) => a - b)
      this.delaySpreadMs = recent[Math.floor((recent.length - 1) * 0.95)] - recent[0]
    }
  }

  private startClock() {
    let next = performance.now() + FRAME_MS
    const loop = () => {
      const now = performance.now()
      let ran = 0
      while (now >= next && ran < 5) {
        this.tick(now)
        next += FRAME_MS
        ran += 1
      }
      if (now - next > 100) next = now + FRAME_MS
      this.clockTimer = setTimeout(loop, Math.max(0, next - performance.now() - 1))
    }
    this.clockTimer = setTimeout(loop, FRAME_MS)
  }

  private tick(now: number) {
    if (this.boost > 0 && now - this.lastBoostChangeMs > 10_000) {
      this.boost -= 1
      this.lastBoostChangeMs = now
    }
    if (!this.playing) {
      if (this.pending.size === 0) return
      if (this.pending.size < this.targetFrames && now - this.firstPendingAtMs < this.targetFrames * FRAME_MS + 20) return
      this.playing = true
      this.concealRun = 0
      this.nextFrameNo = Math.min(...this.pending.keys())
    }
    const target = this.targetFrames
    if (this.maxFrameNo - this.nextFrameNo + 1 > target + 12) {
      const resumeAt = this.maxFrameNo - target + 1
      for (const k of [...this.pending.keys()]) if (k < resumeAt) this.pending.delete(k)
      this.nextFrameNo = resumeAt
    }
    const data = this.pending.get(this.nextFrameNo)
    if (data) {
      this.pending.delete(this.nextFrameNo)
      const decoder = this.getDecoder()
      if (decoder) {
        try {
          decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: this.nextFrameNo * FRAME_MS * 1000, data }))
          this.slots.push("d")
          this.concealRun = 0
        } catch {
          this.slots.push("g")
        }
      }
      this.nextFrameNo += 1
      this.flushGaps()
      return
    }
    const later = this.pending.size > 0
    if (later || (now - this.lastPushMs < LATE_GRACE_MS && this.concealRun < MAX_CONCEAL_RUN)) {
      if (!later && this.boost < 4 && now - this.lastBoostChangeMs > 500) {
        this.boost += 1
        this.lastBoostChangeMs = now
      }
      this.nextFrameNo += 1
      this.concealRun += 1
      this.concealed += 1
      this.slots.push("g")
      this.flushGaps()
      return
    }
    // Talkspurt over.
    this.playing = false
    this.pending.clear()
    this.maxFrameNo = -1
  }

  private getDecoder() {
    if (this.decoder && this.decoder.state !== "closed") return this.decoder
    try {
      const dec = new AudioDecoder({
        output: (audio) => this.onDecoded(audio),
        error: () => {
          // A broken decoder loses its queued frames: drop their slots and start a fresh one.
          this.decoder = null
          this.slots = this.slots.filter((s) => s === "g")
          this.flushGaps()
        }
      })
      dec.configure({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1 })
      this.decoder = dec
      return dec
    } catch {
      return null
    }
  }

  private onDecoded(audio: AudioData) {
    const f32 = new Float32Array(audio.numberOfFrames)
    try {
      audio.copyTo(f32, { planeIndex: 0, format: "f32-planar" })
    } finally {
      audio.close()
    }
    if (this.slots[0] === "d") this.slots.shift()
    const pcm = new Int16Array(FRAME_SAMPLES)
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
      const s = Math.max(-1, Math.min(1, f32[i] ?? 0))
      pcm[i] = s < 0 ? s * 32768 : s * 32767
    }
    this.lastPcm = pcm
    this.emit(pcm)
    this.flushGaps()
  }

  /** Concealed gaps leave in order, right after the decoded frame before them. */
  private flushGaps() {
    while (this.slots[0] === "g") {
      this.slots.shift()
      const run = Math.min(3, this.concealRun || 1)
      const fade = run === 1 ? 0.8 : run === 2 ? 0.5 : 0.25
      const out = new Int16Array(FRAME_SAMPLES)
      if (this.lastPcm) for (let i = 0; i < FRAME_SAMPLES; i += 1) out[i] = this.lastPcm[i] * fade
      this.lastPcm = out
      this.emit(out)
    }
  }

  private emit(pcm: Int16Array) {
    if (!this.deafened) this.onPcm?.(pcm)
  }

  private resetDownlink() {
    this.pending.clear()
    this.playing = false
    this.maxFrameNo = -1
    this.slots = []
    this.lastPcm = null
    this.lastArrivalKey = -1
    this.offsetCount = 0
  }
}

/** Reads mediaSeed from the media token payload (base64url JSON). */
function mediaSeedOf(token: string) {
  const part = token.split(".")[1] ?? ""
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")
  const payload = JSON.parse(atob(b64)) as { mediaSeed?: string }
  if (!payload.mediaSeed) throw new Error("media token has no mediaSeed")
  return payload.mediaSeed
}

function pushSample(target: number[], value: number, max = 1024) {
  target.push(value)
  if (target.length > max) target.splice(0, target.length - max)
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]
}

