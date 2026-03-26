import dgram from "node:dgram"
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"

const MEDIA_MAGIC = Buffer.from([0x56, 0x50, 0x01])
const MEDIA_CIPHER = "aes-256-gcm"

type VoiceClientOptions = {
  host: string
  port: number
  mediaToken: string
  mediaSeed: string
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
  private probeTimer: NodeJS.Timeout | null = null

  constructor(opts: VoiceClientOptions) {
    this.key = Buffer.from(hkdfSync("sha256", Buffer.from(opts.mediaSeed, "base64"), Buffer.from("voip-salt"), Buffer.from("media-key"), 32))
    this.host = opts.host
    this.port = opts.port
    this.mediaToken = opts.mediaToken
  }

  async connect() {
    if (this.connected) return
    await new Promise<void>((resolve) => this.socket.bind(0, "0.0.0.0", () => resolve()))
    this.socket.send(Buffer.from(`HELLO ${this.mediaToken}`), this.port, this.host)
    this.socket.on("message", (buf) => {
      if (this.deafened) return
      const frame = this.decrypt(buf)
      if (!frame) return
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
      this.onPcm16Frame?.(frame.payload)
    })
    this.connected = true
  }

  joinRoom(roomId: string) {
    this.roomId = roomId
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
    const packet = this.encrypt(this.roomId, frame)
    this.socket.send(packet, this.port, this.host)
    this.txPackets += 1
  }

  close() {
    if (this.txTimer) {
      clearInterval(this.txTimer)
      this.txTimer = null
    }
    this.clearProbeTimer()
    this.socket.close()
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
      ping1PctMs: Number(percentile(this.delaySamplesMs, 0.99).toFixed(3)),
      ping01PctMs: Number(percentile(this.delaySamplesMs, 0.999).toFixed(3)),
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

  private ensureProbeTimer() {
    if (this.probeTimer) return
    this.probeTimer = setInterval(() => {
      if (!this.connected || !this.roomId) return
      const silence = Buffer.alloc(960 * 2)
      const packet = this.encrypt(this.roomId, silence)
      this.socket.send(packet, this.port, this.host)
      this.txPackets += 1
    }, 1000)
  }

  private clearProbeTimer() {
    if (!this.probeTimer) return
    clearInterval(this.probeTimer)
    this.probeTimer = null
  }

  private encrypt(roomId: string, payload: Buffer): Buffer {
    const room = Buffer.from(roomId)
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(Date.now() >>> 0, 0)
    nonce.writeUInt32BE(this.seqOut >>> 0, 4)
    randomBytes(4).copy(nonce, 8)
    const cipher = createCipheriv(MEDIA_CIPHER, this.key, nonce, { authTagLength: 16 })
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
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
    const decipher = createDecipheriv(MEDIA_CIPHER, this.key, nonce, { authTagLength: 16 })
    decipher.setAuthTag(tag)
    const payload = Buffer.concat([decipher.update(encrypted), decipher.final()])
    return { seq: packet.readUInt32BE(3), ts: packet.readUInt32BE(7), roomId: packet.subarray(roomStart, roomEnd).toString(), payload }
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
