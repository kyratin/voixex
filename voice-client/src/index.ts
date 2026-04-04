import dgram from "node:dgram"
import net from "node:net"
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"

const MEDIA_MAGIC = Buffer.from([0x56, 0x50, 0x01])
const MEDIA_CIPHER = "aes-256-gcm"
const MEDIA_KIND_AUDIO = 0
const MEDIA_KIND_SCREEN = 1
const MEDIA_KIND_OPUS = 2

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

export class VoiceEngine {
  private readonly socket = dgram.createSocket("udp4")
  private tcpSocket: net.Socket | null = null
  private tcpReadBuf = Buffer.alloc(0)
  private readonly key: Buffer
  private seqOut = 1
  private connected = false
  private muted = false
  private deafened = false
  private roomId: string | null = null
  private readonly host: string
  private readonly port: number
  private readonly mediaToken: string
  private txTimer: NodeJS.Timeout | null = null
  private rxPackets = 0
  private txPackets = 0
  private rxLostEstimated = 0
  private lastSeqIn = 0
  private lastTransitMs: number | null = null
  private jitterMs = 0
  private delaySamplesMs: number[] = []
  private jitterSamplesMs: number[] = []
  private readonly audioDevices: AudioDevice[] = [
    { id: "default-input", label: "Default Input", kind: "input", isDefault: true },
    { id: "default-output", label: "Default Output", kind: "output", isDefault: true }
  ]
  private selectedDevices: AudioDeviceSelection = { inputId: null, outputId: null }
  private onPcm16Frame: ((frame: Buffer) => void) | null = null
  private onScreenChunk: ((chunk: Buffer) => void) | null = null
  private probeTimer: NodeJS.Timeout | null = null
  private lastHelloAtMs = 0
  private helloConfirmed = false
  private helloResolve: (() => void) | null = null
  private helloReject: ((e: Error) => void) | null = null
  private readonly transport: "udp" | "tcp"

  constructor(opts: VoiceClientOptions) {
    this.key = Buffer.from(hkdfSync("sha256", Buffer.from(opts.mediaSeed, "base64"), Buffer.from("voip-salt"), Buffer.from("media-key"), 32))
    this.host = opts.host
    this.port = opts.port
    this.mediaToken = opts.mediaToken
    this.transport = opts.transport ?? "udp"
  }

  async connect() {
    if (this.connected) return
    this.helloConfirmed = false
    if (this.transport === "udp") {
      await new Promise<void>((resolve) => this.socket.bind(0, "0.0.0.0", () => resolve()))
      this.socket.removeAllListeners("message")
      this.socket.on("message", (buf) => this.processIncomingPacket(buf))
    } else {
      await this.connectTcpSocket()
    }
    this.sendHello()
    await this.waitForHello(3500)
    this.connected = true
  }

  joinRoom(roomId: string) {
    this.roomId = roomId
    this.sendHello()
    this.ensureProbeTimer()
  }

  leaveRoom() {
    this.roomId = null
    this.clearProbeTimer()
  }

  setMute(next: boolean) {
    this.muted = next
  }

  setDeafen(next: boolean) {
    this.deafened = next
  }

  sendPcm16Frame(frame: Buffer) {
    if (!this.connected || !this.roomId || this.muted) return
    if (Date.now() - this.lastHelloAtMs > 5000) this.sendHello()
    const packet = this.encrypt(this.roomId, frame, MEDIA_KIND_AUDIO)
    this.sendPacket(packet)
    this.txPackets += 1
  }

  sendOpusFrame(packetPayload: Buffer) {
    if (!this.connected || !this.roomId || this.muted) return
    if (Date.now() - this.lastHelloAtMs > 5000) this.sendHello()
    const packet = this.encrypt(this.roomId, packetPayload, MEDIA_KIND_OPUS)
    this.sendPacket(packet)
    this.txPackets += 1
  }

  sendScreenChunk(chunk: Buffer) {
    if (!this.connected || !this.roomId) return
    if (Date.now() - this.lastHelloAtMs > 5000) this.sendHello()
    const packet = this.encrypt(this.roomId, chunk, MEDIA_KIND_SCREEN)
    this.sendPacket(packet)
    this.txPackets += 1
  }

  close() {
    if (this.txTimer) {
      clearInterval(this.txTimer)
      this.txTimer = null
    }
    this.clearProbeTimer()
    this.failHello(new Error("voice transport closed before HELLO ack"))
    if (this.transport === "udp") {
      this.socket.close()
    } else {
      this.tcpSocket?.destroy()
      this.tcpSocket = null
      this.tcpReadBuf = Buffer.alloc(0)
    }
    this.connected = false
  }

  startSelfTestTone() {
    if (this.txTimer) return
    let phase = 0
    this.txTimer = setInterval(() => {
      const frame = Buffer.alloc(960 * 2)
      for (let i = 0; i < 960; i += 1) {
        const value = Math.round(Math.sin(phase) * 4500)
        frame.writeInt16LE(value, i * 2)
        phase += 0.08
      }
      this.sendPcm16Frame(frame)
    }, 20)
  }

  stopSelfTestTone() {
    if (!this.txTimer) return
    clearInterval(this.txTimer)
    this.txTimer = null
  }

  getStats() {
    const lossPct = this.rxPackets + this.rxLostEstimated > 0
      ? (this.rxLostEstimated / (this.rxPackets + this.rxLostEstimated)) * 100
      : 0
    return {
      connected: this.connected,
      muted: this.muted,
      deafened: this.deafened,
      roomId: this.roomId,
      txPackets: this.txPackets,
      rxPackets: this.rxPackets,
      rxLostEstimated: this.rxLostEstimated,
      packetLossPct: Number(lossPct.toFixed(3)),
      pingNowMs: this.lastTransitMs !== null ? Number(this.lastTransitMs.toFixed(3)) : 0,
      ping1PctMs: Number(percentile(this.delaySamplesMs, 0.99).toFixed(3)),
      ping01PctMs: Number(percentile(this.delaySamplesMs, 0.999).toFixed(3)),
      jitterNowMs: Number(this.jitterMs.toFixed(3)),
      jitter1PctMs: Number(percentile(this.jitterSamplesMs, 0.99).toFixed(3)),
      jitter01PctMs: Number(percentile(this.jitterSamplesMs, 0.999).toFixed(3))
    }
  }

  listAudioDevices() {
    return [...this.audioDevices]
  }

  getAudioDevices() {
    return { ...this.selectedDevices }
  }

  setAudioDevices(input: AudioDeviceSelection) {
    this.selectedDevices = {
      inputId: input.inputId,
      outputId: input.outputId
    }
    return this.getAudioDevices()
  }

  setOnPcm16Frame(listener: ((frame: Buffer) => void) | null) {
    this.onPcm16Frame = listener
  }

  setOnScreenChunk(listener: ((chunk: Buffer) => void) | null) {
    this.onScreenChunk = listener
  }

  private ensureProbeTimer() {
    if (this.probeTimer) return
    this.probeTimer = setInterval(() => {
      if (!this.connected || !this.roomId) return
      if (Date.now() - this.lastHelloAtMs > 5000) this.sendHello()
      const silence = Buffer.alloc(960 * 2)
      const packet = this.encrypt(this.roomId, silence, MEDIA_KIND_AUDIO)
      this.sendPacket(packet)
      this.txPackets += 1
    }, 1000)
  }

  private clearProbeTimer() {
    if (!this.probeTimer) return
    clearInterval(this.probeTimer)
    this.probeTimer = null
  }

  private sendHello() {
    const hello = Buffer.from(`HELLO ${this.mediaToken}`)
    if (this.transport === "udp") {
      this.socket.send(hello, this.port, this.host)
    } else if (this.tcpSocket && !this.tcpSocket.destroyed) {
      this.tcpSocket.write(this.frameTcp(hello))
    }
    this.lastHelloAtMs = Date.now()
  }

  private encrypt(roomId: string, payload: Buffer, kind: number): Buffer {
    const room = Buffer.from(roomId)
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(Date.now() >>> 0, 0)
    nonce.writeUInt32BE(this.seqOut >>> 0, 4)
    randomBytes(4).copy(nonce, 8)
    const cipher = createCipheriv(MEDIA_CIPHER, this.key, nonce, { authTagLength: 16 })
    const plaintext = Buffer.concat([Buffer.from([kind & 0xff]), payload])
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    const header = Buffer.alloc(3 + 4 + 4 + 1 + room.length + 12 + 2)
    MEDIA_MAGIC.copy(header, 0)
    header.writeUInt32BE(this.seqOut++, 3)
    header.writeUInt32BE(Date.now() >>> 0, 7)
    header.writeUInt8(room.length, 11)
    room.copy(header, 12)
    nonce.copy(header, 12 + room.length)
    header.writeUInt16BE(tag.length, 12 + room.length + 12)
    return Buffer.concat([header, encrypted, tag])
  }

  private decrypt(packet: Buffer) {
    if (packet.length < 3 + 4 + 4 + 1 + 12 + 2 + 16) return null
    if (!packet.subarray(0, 3).equals(MEDIA_MAGIC)) return null
    const roomLen = packet.readUInt8(11)
    const roomStart = 12
    const roomEnd = roomStart + roomLen
    const nonceStart = roomEnd
    const nonceEnd = nonceStart + 12
    const tagLenPos = nonceEnd
    const tagLen = packet.readUInt16BE(tagLenPos)
    const encStart = tagLenPos + 2
    const encEnd = packet.length - tagLen
    const nonce = packet.subarray(nonceStart, nonceEnd)
    const encrypted = packet.subarray(encStart, encEnd)
    const tag = packet.subarray(encEnd)
    let plaintext: Buffer
    try {
      const decipher = createDecipheriv(MEDIA_CIPHER, this.key, nonce, { authTagLength: 16 })
      decipher.setAuthTag(tag)
      plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()])
    } catch {
      return null
    }
    if (plaintext.length < 1) return null
    const kind = plaintext.readUInt8(0)
    const payload = plaintext.subarray(1)
    return { seq: packet.readUInt32BE(3), ts: packet.readUInt32BE(7), roomId: packet.subarray(roomStart, roomEnd).toString(), kind, payload }
  }

  private processIncomingPacket(buf: Buffer) {
    if (buf.equals(Buffer.from("HELLO_ACK"))) {
      this.markHelloConfirmed()
      return
    }
    if (buf.equals(Buffer.from("HELLO_FAIL"))) {
      this.failHello(new Error("Voice HELLO rejected by server"))
      return
    }
    const frame = this.decrypt(buf)
    if (!frame) return
    this.markHelloConfirmed()
    if (this.lastSeqIn > 0 && frame.seq > this.lastSeqIn + 1) {
      this.rxLostEstimated += frame.seq - this.lastSeqIn - 1
    }
    this.lastSeqIn = Math.max(this.lastSeqIn, frame.seq)
    this.rxPackets += 1
    const nowTs32 = Date.now() >>> 0
    const transit = safeTransitDeltaMs(nowTs32, frame.ts)
    if (transit !== null) {
      pushSample(this.delaySamplesMs, transit)
      if (this.lastTransitMs !== null) {
        const d = Math.abs(transit - this.lastTransitMs)
        this.jitterMs += (d - this.jitterMs) / 16
        pushSample(this.jitterSamplesMs, this.jitterMs)
      }
      this.lastTransitMs = transit
    }
    if (frame.kind === MEDIA_KIND_AUDIO && frame.payload.length > 0) {
      if (this.deafened) return
      this.onPcm16Frame?.(frame.payload)
    } else if (frame.kind === MEDIA_KIND_SCREEN && frame.payload.length > 0) {
      this.onScreenChunk?.(frame.payload)
    }
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
      const timer = setTimeout(() => {
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
        resolve()
      }
      this.helloReject = (e) => {
        clearTimeout(timer)
        reject(e)
      }
    })
  }

  private sendPacket(packet: Buffer) {
    if (this.transport === "udp") {
      this.socket.send(packet, this.port, this.host)
      return
    }
    if (!this.tcpSocket || this.tcpSocket.destroyed) return
    this.tcpSocket.write(this.frameTcp(packet))
  }

  private frameTcp(payload: Buffer) {
    const out = Buffer.alloc(4 + payload.length)
    out.writeUInt32BE(payload.length, 0)
    payload.copy(out, 4)
    return out
  }

  private async connectTcpSocket() {
    this.tcpReadBuf = Buffer.alloc(0)
    this.tcpSocket = net.createConnection({ host: this.host, port: this.port })
    this.tcpSocket.on("data", (chunk: Buffer) => {
      this.tcpReadBuf = Buffer.concat([this.tcpReadBuf, chunk])
      while (this.tcpReadBuf.length >= 4) {
        const len = this.tcpReadBuf.readUInt32BE(0)
        if (len <= 0 || len > 64 * 1024) {
          this.failHello(new Error("Voice TCP frame size invalid"))
          this.tcpSocket?.destroy()
          return
        }
        if (this.tcpReadBuf.length < 4 + len) return
        const payload = this.tcpReadBuf.subarray(4, 4 + len)
        this.tcpReadBuf = this.tcpReadBuf.subarray(4 + len)
        this.processIncomingPacket(payload)
      }
    })
    this.tcpSocket.on("error", (e) => {
      if (!this.connected) {
        this.failHello(new Error(`Voice TCP connect error: ${e.message}`))
      }
    })
    this.tcpSocket.on("close", () => {
      if (!this.connected) {
        this.failHello(new Error("Voice TCP socket closed before HELLO ack"))
      }
      this.connected = false
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Voice TCP connect timeout"))
      }, 3000)
      this.tcpSocket?.once("connect", () => {
        clearTimeout(timer)
        resolve()
      })
      this.tcpSocket?.once("error", (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
  }
}

function pushSample(target: number[], value: number, maxLen = 2048) {
  target.push(value)
  if (target.length > maxLen) {
    target.splice(0, target.length - maxLen)
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[idx]
}

function safeTransitDeltaMs(nowTs32: number, packetTs32: number): number | null {
  // Signed 32-bit delta protects against wrap/clock skew artifacts.
  const signedDelta = (nowTs32 - packetTs32) | 0
  if (signedDelta < 0) return null
  if (signedDelta > 60_000) return null
  return signedDelta
}
