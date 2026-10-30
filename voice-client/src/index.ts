import dgram from "node:dgram"
import net from "node:net"
import { createRequire } from "node:module"
import { SpeakerStream, type OpusDecoderLike } from "./jitter.js"
import {
  FRAME_MS,
  FRAME_SAMPLES,
  KIND_OPUS,
  KIND_OPUS2,
  KIND_PCM,
  KIND_PROBE,
  KIND_PROBE_ACK,
  KIND_SCREEN,
  OPUS2_FLAG_TALKSPURT,
  ReplayWindow,
  SAMPLE_RATE,
  decodeOpus2,
  decodeProbeAck,
  decryptPacket,
  deriveMediaKey,
  encodeOpus2,
  encodeProbe,
  encryptPacket,
  type DecryptedPacket
} from "./protocol.js"

type OpusCodec = {
  encode(pcm: Buffer, frameSize: number): Buffer
  decode(data: Buffer): Buffer
  setBitrate(bitrate: number): void
  encoderCTL(ctl: number, value: number): void
  delete(): void
}
type OpusCtor = (new (rate: number, channels: number, application: number) => OpusCodec) & { Application: { VOIP: number } }
const requireCjs = createRequire(import.meta.url)
const OpusScript = requireCjs("opusscript") as OpusCtor

type VoiceClientOptions = {
  host: string
  port: number
  mediaToken: string
  mediaSeed: string
  transport?: "udp" | "tcp"
}

export type AudioDevice = {
  id: string
  label: string
  kind: "input" | "output"
  isDefault?: boolean
}

export type AudioDeviceSelection = {
  inputId: string | null
  outputId: string | null
}

/** Uplink bitrate steps chosen from the loss the server reports for our packets. */
const BITRATE_GOOD = 32_000
const BITRATE_LOSSY = 24_000
const BITRATE_BAD = 16_000
/** No frame for this long means the capture stopped (mute, silence gate): next frame starts a talkspurt. */
const SEND_GAP_MS = 80
/** How long to wait for an "opus2" HELLO_ACK before falling back to the original protocol. */
const HELLO2_WAIT_MS = 1200
const TCP_MAX_BACKLOG_BYTES = 16 * 1024
/** In a row of packets that all look like replays: the server started a new session (restart, new endpoint). */
const STALE_RUN_RESET = 25

/**
 * Desktop voice transport.
 *
 * With servers that answer HELLO2 ("opus2"), audio goes both ways as Opus (~32 kbit/s instead of
 * 768 kbit/s raw PCM) with numbered frames and a redundant copy of the previous frame, received
 * through an adaptive jitter buffer and played out on a steady 20 ms clock. Older servers get the
 * original raw-PCM protocol.
 */
export class VoiceEngine {
  private udp: dgram.Socket | null = null
  private tcpSocket: net.Socket | null = null
  private tcpReadBuf: Buffer = Buffer.alloc(0)
  private readonly key: Buffer
  private seqOut = 1
  private connected = false
  private closing = false
  private tcpReconnectTimer: NodeJS.Timeout | null = null
  private tcpReconnectDelayMs = 1000
  /** Packets in a row rejected by the replay window (see STALE_RUN_RESET). */
  private staleRun = 0
  private muted = false
  private deafened = false
  private roomId: string | null = null
  private readonly host: string
  private readonly port: number
  private mediaToken: string
  private readonly transport: "udp" | "tcp"
  private txTimer: NodeJS.Timeout | null = null
  private probeTimer: NodeJS.Timeout | null = null
  private playoutTimer: NodeJS.Timeout | null = null
  private lastHelloAtMs = 0
  private helloConfirmed = false
  private helloResolve: (() => void) | null = null
  private helloReject: ((e: Error) => void) | null = null
  /** Server speaks the opus2 protocol (decided by its HELLO_ACK). */
  private opus2 = false
  /** Still offering HELLO2; switches to plain HELLO when an old server ignores it. */
  private offerOpus2 = true
  private readonly replay = new ReplayWindow()

  // Uplink
  private encoder: OpusCodec | null = null
  private bitrate = BITRATE_GOOD
  private redundancy = 1
  private txFrameNo = 0
  private lastSendMs = 0
  private recentEncoded: Buffer[] = []
  private uplinkLossPct = 0

  // Downlink
  private decoder: OpusCodec | null = null
  private readonly stream = new SpeakerStream(() => this.getDecoder())
  private rxLoss = { expected: 0, received: 0, highest: -1 }
  private lastLegacyArrivalMs = 0

  // Stats
  private rxPackets = 0
  private txPackets = 0
  private rxLostEstimated = 0
  private lastSeqIn = 0
  private rttMs: number | null = null
  private rttSamples: number[] = []
  private legacyJitterMs = 0
  private jitterSamples: number[] = []

  private readonly audioDevices: AudioDevice[] = [
    { id: "default-input", label: "Default Input", kind: "input", isDefault: true },
    { id: "default-output", label: "Default Output", kind: "output", isDefault: true }
  ]
  private selectedDevices: AudioDeviceSelection = { inputId: null, outputId: null }
  private onPcm16Frame: ((frame: Buffer) => void) | null = null
  private onScreenChunk: ((chunk: Buffer) => void) | null = null

  constructor(opts: VoiceClientOptions) {
    this.key = deriveMediaKey(opts.mediaSeed)
    this.host = opts.host
    this.port = opts.port
    this.mediaToken = opts.mediaToken
    this.transport = opts.transport ?? "udp"
  }

  async connect() {
    if (this.connected) return
    this.closing = false
    this.helloConfirmed = false
    if (this.transport === "udp") {
      const socket = dgram.createSocket({ type: "udp4", recvBufferSize: 1 << 20, sendBufferSize: 1 << 20 })
      this.udp = socket
      await new Promise<void>((resolve) => socket.bind(0, "0.0.0.0", () => resolve()))
      socket.on("message", (buf) => this.processIncomingPacket(buf))
      socket.on("error", (e) => {
        if (!this.connected) this.failHello(new Error(`Voice UDP socket error: ${e.message}`))
      })
    } else {
      await this.connectTcpSocket()
    }
    this.sendHello()
    try {
      await this.waitForHello(HELLO2_WAIT_MS)
    } catch {
      // An old server ignores HELLO2 (UDP) or closes the connection (TCP): use the original protocol.
      this.offerOpus2 = false
      if (this.transport === "tcp") await this.connectTcpSocket()
      this.sendHello()
      await this.waitForHello(3500)
    }
    this.connected = true
    this.ensureProbeTimer()
  }

  joinRoom(roomId: string) {
    if (this.roomId !== roomId) this.resetStreams()
    this.roomId = roomId
    this.sendHello()
    this.ensureProbeTimer()
    this.ensurePlayoutClock()
  }

  leaveRoom() {
    this.roomId = null
    this.resetStreams()
  }

  setMute(next: boolean) {
    this.muted = next
  }

  setDeafen(next: boolean) {
    this.deafened = next
  }

  /** One 20 ms frame of 48 kHz mono PCM16 from the microphone. */
  sendPcm16Frame(frame: Buffer) {
    if (!this.connected || !this.roomId || this.muted) return
    this.keepHelloFresh()
    if (!this.opus2) {
      this.sendPacket(this.encrypt(this.roomId, frame, KIND_PCM))
      return
    }
    const now = Date.now()
    let flags = 0
    if (this.lastSendMs === 0 || now - this.lastSendMs > SEND_GAP_MS) {
      // Keep frame numbers in step with time across a pause, so the server's buffer sizing
      // does not mistake the pause for network delay.
      if (this.lastSendMs > 0) this.txFrameNo += Math.max(1, Math.round((now - this.lastSendMs) / FRAME_MS)) - 1
      this.recentEncoded = []
      flags = OPUS2_FLAG_TALKSPURT
    }
    this.lastSendMs = now
    let encoded: Buffer
    try {
      encoded = this.getEncoder().encode(frame.length === FRAME_SAMPLES * 2 ? frame : fitFrame(frame), FRAME_SAMPLES)
    } catch {
      return
    }
    const frameNo = this.txFrameNo++
    const payload = encodeOpus2(frameNo, flags, [encoded, ...this.recentEncoded.slice(0, this.transport === "tcp" ? 0 : this.redundancy)])
    this.recentEncoded = [encoded, ...this.recentEncoded].slice(0, 3)
    this.sendPacket(this.encrypt(this.roomId, payload, KIND_OPUS2))
  }

  /** Pre-encoded Opus from the renderer (old path). With opus2 servers the engine encodes itself. */
  sendOpusFrame(packetPayload: Buffer) {
    if (!this.connected || !this.roomId || this.muted) return
    this.keepHelloFresh()
    this.sendPacket(this.encrypt(this.roomId, packetPayload, KIND_OPUS))
  }

  sendScreenChunk(chunk: Buffer) {
    if (!this.connected || !this.roomId) return
    this.keepHelloFresh()
    this.sendPacket(this.encrypt(this.roomId, chunk, KIND_SCREEN))
  }

  /** A fresh token from the server (same key); used for HELLO from now on. */
  setMediaToken(token: string) {
    this.mediaToken = token
  }

  close() {
    this.closing = true
    this.stopSelfTestTone()
    for (const t of [this.probeTimer, this.playoutTimer, this.tcpReconnectTimer]) if (t) clearTimeout(t)
    this.probeTimer = null
    this.playoutTimer = null
    this.tcpReconnectTimer = null
    this.failHello(new Error("voice transport closed before HELLO ack"))
    try {
      this.udp?.close()
    } catch {
      /* already closed */
    }
    this.udp = null
    this.tcpSocket?.destroy()
    this.tcpSocket = null
    this.tcpReadBuf = Buffer.alloc(0)
    this.encoder?.delete()
    this.decoder?.delete()
    this.encoder = null
    this.decoder = null
    this.connected = false
  }

  startSelfTestTone() {
    if (this.txTimer) return
    let phase = 0
    this.txTimer = setInterval(() => {
      const frame = Buffer.alloc(FRAME_SAMPLES * 2)
      for (let i = 0; i < FRAME_SAMPLES; i += 1) {
        frame.writeInt16LE(Math.round(Math.sin(phase) * 4500), i * 2)
        phase += 0.08
      }
      this.sendPcm16Frame(frame)
    }, FRAME_MS)
  }

  stopSelfTestTone() {
    if (!this.txTimer) return
    clearInterval(this.txTimer)
    this.txTimer = null
  }

  getStats() {
    const lossPct = this.opus2
      ? this.rxLoss.expected > 0
        ? (Math.max(0, this.rxLoss.expected - this.rxLoss.received) * 100) / this.rxLoss.expected
        : 0
      : this.rxPackets + this.rxLostEstimated > 0
        ? (this.rxLostEstimated / (this.rxPackets + this.rxLostEstimated)) * 100
        : 0
    const jitterNow = this.opus2 ? this.stream.jitter : this.legacyJitterMs
    return {
      connected: this.connected,
      muted: this.muted,
      deafened: this.deafened,
      roomId: this.roomId,
      codec: this.opus2 ? "opus" : "pcm",
      txPackets: this.txPackets,
      rxPackets: this.rxPackets,
      rxLostEstimated: this.rxLostEstimated,
      packetLossPct: round3(lossPct),
      uplinkLossPct: round3(this.uplinkLossPct),
      uplinkBitrate: this.opus2 ? this.bitrate : null,
      // Real round trip (probe echo), not "server clock minus client clock" as before.
      pingNowMs: this.rttMs !== null ? round3(this.rttMs) : 0,
      ping1PctMs: round3(percentile(this.rttSamples, 0.99)),
      ping01PctMs: round3(percentile(this.rttSamples, 0.999)),
      jitterNowMs: round3(jitterNow),
      jitter1PctMs: round3(percentile(this.jitterSamples, 0.99)),
      jitter01PctMs: round3(percentile(this.jitterSamples, 0.999)),
      jitterBufferMs: this.opus2 ? this.stream.targetFrames * FRAME_MS : null,
      concealedFrames: this.stream.stats.concealed
    }
  }

  listAudioDevices() {
    return [...this.audioDevices]
  }

  getAudioDevices() {
    return { ...this.selectedDevices }
  }

  setAudioDevices(input: AudioDeviceSelection) {
    this.selectedDevices = { inputId: input.inputId, outputId: input.outputId }
    return this.getAudioDevices()
  }

  setOnPcm16Frame(listener: ((frame: Buffer) => void) | null) {
    this.onPcm16Frame = listener
  }

  setOnScreenChunk(listener: ((chunk: Buffer) => void) | null) {
    this.onScreenChunk = listener
  }

  private getEncoder() {
    if (this.encoder) return this.encoder
    const enc = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP)
    enc.setBitrate(this.bitrate)
    for (const [ctl, value] of [
      [4010, 8], // OPUS_SET_COMPLEXITY
      [4024, 3001], // OPUS_SET_SIGNAL → voice
      [4006, 1], // OPUS_SET_VBR
      [4016, 0] // OPUS_SET_DTX off: steady frames keep the server's timing estimate stable
    ] as const) {
      try {
        enc.encoderCTL(ctl, value)
      } catch {
        /* optional tuning */
      }
    }
    this.encoder = enc
    return enc
  }

  private getDecoder(): OpusDecoderLike {
    this.decoder ??= new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP)
    return this.decoder
  }

  private resetStreams() {
    this.lastSendMs = 0
    this.recentEncoded = []
    this.rxLoss = { expected: 0, received: 0, highest: -1 }
  }

  /** The server's side starts over: forget its packet and frame numbers. */
  private restartDownlink() {
    this.replay.reset()
    this.staleRun = 0
    this.lastSeqIn = 0
    this.stream.reset()
    this.rxLoss = { expected: 0, received: 0, highest: -1 }
  }

  /** TCP voice dropped mid-call (network change, server restart): reconnect until it works. */
  private scheduleTcpReconnect() {
    if (this.closing || this.tcpReconnectTimer) return
    this.tcpReconnectTimer = setTimeout(() => {
      this.tcpReconnectTimer = null
      void this.reconnectTcp()
    }, this.tcpReconnectDelayMs)
    this.tcpReconnectDelayMs = Math.min(10_000, this.tcpReconnectDelayMs * 2)
  }

  private async reconnectTcp() {
    if (this.closing) return
    try {
      this.helloConfirmed = false
      await this.connectTcpSocket()
      this.sendHello()
      await this.waitForHello(3500)
      if (this.closing) return
      this.restartDownlink()
      this.lastSendMs = 0
      this.recentEncoded = []
      this.connected = true
      this.tcpReconnectDelayMs = 1000
    } catch {
      this.scheduleTcpReconnect()
    }
  }

  /** Server's view of our uplink: lower the bitrate and add redundancy when packets get lost. */
  private adaptUplink(lossPct: number) {
    this.uplinkLossPct = lossPct
    const bitrate = lossPct > 10 ? BITRATE_BAD : lossPct > 3 ? BITRATE_LOSSY : BITRATE_GOOD
    this.redundancy = lossPct > 10 ? 3 : lossPct > 3 ? 2 : 1
    if (bitrate !== this.bitrate) {
      this.bitrate = bitrate
      this.encoder?.setBitrate(bitrate)
    }
  }

  /** Decoded downlink audio leaves on a steady 20 ms clock (drift-free, catches up after a stall). */
  private ensurePlayoutClock() {
    if (this.playoutTimer) return
    let next = performance.now() + FRAME_MS
    const loop = () => {
      const now = performance.now()
      let ran = 0
      while (now >= next && ran < 5) {
        const frame = this.stream.pull(Date.now())
        if (frame && !this.deafened) this.onPcm16Frame?.(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength))
        next += FRAME_MS
        ran += 1
      }
      if (now - next > 100) next = now + FRAME_MS
      this.playoutTimer = setTimeout(loop, Math.max(0, next - performance.now() - 1))
    }
    this.playoutTimer = setTimeout(loop, FRAME_MS)
  }

  private ensureProbeTimer() {
    if (this.probeTimer) return
    const tick = () => {
      this.probeTimer = setTimeout(tick, 1000)
      if (!this.connected) return
      this.keepHelloFresh()
      if (this.opus2) {
        const lossPct = this.rxLoss.expected > 0 ? (Math.max(0, this.rxLoss.expected - this.rxLoss.received) * 100) / this.rxLoss.expected : 0
        const probe = encodeProbe(Date.now() >>> 0, {
          lossPermille: lossPct * 10,
          jitterMs: this.stream.jitter,
          bufferMs: this.stream.targetFrames * FRAME_MS
        })
        this.sendPacket(this.encrypt(this.roomId ?? "", probe, KIND_PROBE), true)
        // Loss is reported per second; start a fresh window.
        this.rxLoss = { expected: 0, received: 0, highest: this.rxLoss.highest }
      } else if (this.roomId) {
        // Original keepalive: the server answers with an empty frame echoing our timestamp.
        this.sendPacket(this.encrypt(this.roomId, Buffer.alloc(FRAME_SAMPLES * 2), KIND_PCM))
      }
    }
    this.probeTimer = setTimeout(tick, 200)
  }

  private keepHelloFresh() {
    if (Date.now() - this.lastHelloAtMs > 5000) this.sendHello()
  }

  private helloText() {
    return this.offerOpus2 ? `HELLO2 ${this.mediaToken} opus2` : `HELLO ${this.mediaToken}`
  }

  private sendHello() {
    const hello = Buffer.from(this.helloText())
    if (this.transport === "udp") {
      this.udp?.send(hello, this.port, this.host, (err) => {
        if (err && !this.connected) this.failHello(new Error(`Voice UDP send error: ${err.message}`))
      })
    } else if (this.tcpSocket && !this.tcpSocket.destroyed) {
      this.tcpSocket.write(frameTcp(hello))
    }
    this.lastHelloAtMs = Date.now()
  }

  private encrypt(roomId: string, payload: Buffer, kind: number): Buffer {
    return encryptPacket(this.key, this.seqOut++, Date.now(), roomId, payload, kind)
  }

  private processIncomingPacket(buf: Buffer) {
    if (buf.length < 64 && buf[0] === 0x48 /* H */) {
      const text = buf.toString()
      if (text.startsWith("HELLO_ACK")) {
        this.opus2 = text.includes("opus2")
        this.markHelloConfirmed()
        return
      }
      if (text === "HELLO_FAIL") {
        this.failHello(new Error("Voice HELLO rejected by server"))
        return
      }
    }
    const frame = decryptPacket(this.key, buf)
    if (!frame) return
    this.markHelloConfirmed()
    if (!this.replay.accept(frame.seq)) {
      // The server numbers its packets per session. After it restarts, or opens a new session for
      // a new address or TCP connection, it counts from 1 again and every packet would look like a
      // replay: the call would go silent while the speaking rings keep moving.
      this.staleRun += 1
      if (this.staleRun < STALE_RUN_RESET) return
      this.restartDownlink()
      this.replay.accept(frame.seq)
    }
    this.staleRun = 0
    this.rxPackets += 1
    if (this.lastSeqIn > 0 && frame.seq > this.lastSeqIn + 1) this.rxLostEstimated += frame.seq - this.lastSeqIn - 1
    this.lastSeqIn = Math.max(this.lastSeqIn, frame.seq)

    switch (frame.kind) {
      case KIND_PROBE_ACK:
        return this.onProbeAck(frame)
      case KIND_OPUS2:
        return this.onOpus2(frame)
      case KIND_PCM:
        if (frame.payload.length === 0) {
          // Old servers echo our timestamp in an empty frame: that is a real round trip.
          this.recordRtt(((Date.now() >>> 0) - frame.ts) | 0)
          return
        }
        this.trackLegacyJitter()
        if (!this.deafened) this.onPcm16Frame?.(frame.payload)
        return
      case KIND_SCREEN:
        if (frame.payload.length > 0) this.onScreenChunk?.(frame.payload)
        return
    }
  }

  private onProbeAck(frame: DecryptedPacket) {
    const ack = decodeProbeAck(frame.payload)
    if (!ack) return
    this.recordRtt(((Date.now() >>> 0) - ack.clientMs) | 0)
    this.adaptUplink(ack.report.lossPermille / 10)
  }

  private onOpus2(frame: DecryptedPacket) {
    const packet = decodeOpus2(frame.payload)
    if (!packet) return
    const now = Date.now()
    const primary = packet.frames[0].frameNo
    const loss = this.rxLoss
    if (primary > loss.highest) {
      const step = primary - loss.highest
      loss.expected += loss.highest < 0 || step >= 25 ? 1 : step
      loss.highest = primary
    }
    loss.received += 1
    packet.frames.forEach((f, i) => {
      this.stream.push(
        {
          mode: "numbered",
          frameNo: f.frameNo,
          data: Buffer.from(f.data),
          primary: i === 0,
          talkspurt: i === 0 && (packet.flags & OPUS2_FLAG_TALKSPURT) !== 0
        },
        now
      )
    })
    pushSample(this.jitterSamples, this.stream.jitter)
  }

  private recordRtt(rtt: number) {
    if (rtt < 0 || rtt > 10_000) return
    this.rttMs = rtt
    pushSample(this.rttSamples, rtt, 300)
  }

  /** Old servers: interarrival jitter of the 20 ms mix frames (no clock comparison involved). */
  private trackLegacyJitter() {
    const now = Date.now()
    if (this.lastLegacyArrivalMs > 0 && now - this.lastLegacyArrivalMs < 200) {
      const d = Math.abs(now - this.lastLegacyArrivalMs - FRAME_MS)
      this.legacyJitterMs += (d - this.legacyJitterMs) / 16
      pushSample(this.jitterSamples, this.legacyJitterMs)
    }
    this.lastLegacyArrivalMs = now
  }

  private markHelloConfirmed() {
    if (this.helloConfirmed) return
    this.helloConfirmed = true
    const resolve = this.helloResolve
    this.helloResolve = null
    this.helloReject = null
    resolve?.()
  }

  private failHello(err: Error) {
    const reject = this.helloReject
    this.helloResolve = null
    this.helloReject = null
    reject?.(err)
  }

  private waitForHello(timeoutMs: number) {
    if (this.helloConfirmed) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const retryTimer = setInterval(() => {
        if (!this.helloConfirmed) this.sendHello()
      }, 400)
      const timer = setTimeout(() => {
        clearInterval(retryTimer)
        this.helloResolve = null
        this.helloReject = null
        reject(
          new Error(
            this.transport === "udp"
              ? "Voice HELLO timeout on UDP. UDP may be blocked; try TCP transport."
              : "Voice HELLO timeout on TCP. Try UDP transport if available."
          )
        )
      }, timeoutMs)
      this.helloResolve = () => {
        clearTimeout(timer)
        clearInterval(retryTimer)
        resolve()
      }
      this.helloReject = (e) => {
        clearTimeout(timer)
        clearInterval(retryTimer)
        reject(e)
      }
    })
  }

  private sendPacket(packet: Buffer, control = false) {
    if (this.transport === "udp") {
      this.udp?.send(packet, this.port, this.host)
    } else {
      const sock = this.tcpSocket
      if (!sock || sock.destroyed) return
      // A congested TCP link: skip audio rather than build up seconds of delay.
      if (!control && sock.writableLength > TCP_MAX_BACKLOG_BYTES) return
      sock.write(frameTcp(packet))
    }
    this.txPackets += 1
  }

  private async connectTcpSocket() {
    this.tcpSocket?.destroy()
    this.tcpReadBuf = Buffer.alloc(0)
    const sock = net.createConnection({ host: this.host, port: this.port })
    this.tcpSocket = sock
    sock.setNoDelay(true)
    sock.on("data", (chunk: Buffer) => {
      if (this.tcpSocket !== sock) return
      this.tcpReadBuf = this.tcpReadBuf.length === 0 ? chunk : Buffer.concat([this.tcpReadBuf, chunk])
      let off = 0
      while (this.tcpReadBuf.length - off >= 4) {
        const len = this.tcpReadBuf.readUInt32BE(off)
        if (len <= 0 || len > 64 * 1024) {
          this.failHello(new Error("Voice TCP frame size invalid"))
          sock.destroy()
          return
        }
        if (this.tcpReadBuf.length - off < 4 + len) break
        const payload = this.tcpReadBuf.subarray(off + 4, off + 4 + len)
        off += 4 + len
        this.processIncomingPacket(payload)
      }
      this.tcpReadBuf = off === this.tcpReadBuf.length ? Buffer.alloc(0) : this.tcpReadBuf.subarray(off)
    })
    sock.on("error", (e) => {
      if (!this.connected && this.tcpSocket === sock) this.failHello(new Error(`Voice TCP connect error: ${e.message}`))
    })
    sock.on("close", () => {
      if (this.tcpSocket !== sock) return
      if (!this.connected) {
        this.failHello(new Error("Voice TCP socket closed before HELLO ack"))
        return
      }
      this.connected = false
      this.scheduleTcpReconnect()
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Voice TCP connect timeout")), 3000)
      sock.once("connect", () => {
        clearTimeout(timer)
        resolve()
      })
      sock.once("error", (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
  }
}

function frameTcp(payload: Buffer) {
  const out = Buffer.allocUnsafe(4 + payload.length)
  out.writeUInt32BE(payload.length, 0)
  payload.copy(out, 4)
  return out
}

function fitFrame(frame: Buffer) {
  const out = Buffer.alloc(FRAME_SAMPLES * 2)
  frame.copy(out, 0, 0, Math.min(frame.length, out.length))
  return out
}

function pushSample(target: number[], value: number, maxLen = 2048) {
  target.push(value)
  if (target.length > maxLen) target.splice(0, target.length - maxLen)
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]
}

const round3 = (v: number) => Number(v.toFixed(3))
