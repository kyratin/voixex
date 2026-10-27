import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
const MEDIA_MAGIC = Buffer.from([0x56, 0x50, 0x01])

/**
 * Voice media packet format (UDP datagram or length-prefixed TCP frame):
 *   magic(3) seq(u32) ts(u32) roomLen(u8) room nonce(12) tagLen(u16) | AES-256-GCM( kind(u8) payload ) | tag
 *
 * Kinds 0–2 are the original protocol; 3–5 are only used with clients that sent HELLO2 with the
 * matching capability, so older clients keep working unchanged.
 */
export const KIND_PCM = 0
export const KIND_SCREEN = 1
/** One Opus frame per packet, no frame number (old clients). */
export const KIND_OPUS = 2
/** Opus with a frame number and redundant copies of the previous frames (see encodeOpus2). */
export const KIND_OPUS2 = 3
/** Client clock + client's receive stats; answered immediately with KIND_PROBE_ACK. */
export const KIND_PROBE = 4
export const KIND_PROBE_ACK = 5

export const FRAME_MS = 20
export const SAMPLE_RATE = 48_000
export const FRAME_SAMPLES = 960
export const PCM_FRAME_BYTES = FRAME_SAMPLES * 2

const CIPHER = "aes-256-gcm"

export function deriveMediaKey(mediaSeedB64: string) {
  return Buffer.from(hkdfSync("sha256", Buffer.from(mediaSeedB64, "base64"), Buffer.from("voip-salt"), Buffer.from("media-key"), 32))
}

export function encryptPacket(key: Buffer, seq: number, ts: number, roomId: string, payload: Buffer, kind: number): Buffer {
  const room = Buffer.from(roomId)
  const nonce = Buffer.alloc(12)
  nonce.writeUInt32BE(ts >>> 0, 0)
  nonce.writeUInt32BE(seq >>> 0, 4)
  randomBytes(4).copy(nonce, 8)
  const cipher = createCipheriv(CIPHER, key, nonce, { authTagLength: 16 })
  const encrypted = Buffer.concat([cipher.update(Buffer.from([kind & 0xff])), cipher.update(payload), cipher.final()])
  const tag = cipher.getAuthTag()
  const header = Buffer.alloc(3 + 4 + 4 + 1 + room.length + 12 + 2)
  MEDIA_MAGIC.copy(header, 0)
  header.writeUInt32BE(seq >>> 0, 3)
  header.writeUInt32BE(ts >>> 0, 7)
  header.writeUInt8(room.length, 11)
  room.copy(header, 12)
  nonce.copy(header, 12 + room.length)
  header.writeUInt16BE(tag.length, 12 + room.length + 12)
  return Buffer.concat([header, encrypted, tag])
}

export type DecryptedPacket = { seq: number; ts: number; roomId: string; kind: number; payload: Buffer }

export function decryptPacket(key: Buffer, packet: Buffer): DecryptedPacket | null {
  if (packet.length < 3 + 4 + 4 + 1 + 12 + 2 + 16) return null
  if (packet[0] !== MEDIA_MAGIC[0] || packet[1] !== MEDIA_MAGIC[1] || packet[2] !== MEDIA_MAGIC[2]) return null
  const seq = packet.readUInt32BE(3)
  const ts = packet.readUInt32BE(7)
  const roomEnd = 12 + packet.readUInt8(11)
  const nonceEnd = roomEnd + 12
  if (nonceEnd + 2 > packet.length) return null
  const tagLen = packet.readUInt16BE(nonceEnd)
  const encStart = nonceEnd + 2
  const encEnd = packet.length - tagLen
  if (tagLen !== 16 || encEnd <= encStart) return null
  let plaintext: Buffer
  try {
    const decipher = createDecipheriv(CIPHER, key, packet.subarray(roomEnd, nonceEnd), { authTagLength: 16 })
    decipher.setAuthTag(packet.subarray(encEnd))
    plaintext = Buffer.concat([decipher.update(packet.subarray(encStart, encEnd)), decipher.final()])
  } catch {
    return null
  }
  if (plaintext.length < 1) return null
  return {
    seq,
    ts,
    roomId: packet.subarray(12, roomEnd).toString(),
    kind: plaintext[0],
    payload: plaintext.subarray(1)
  }
}

/** Marks the first frame after a pause: the receiver re-buffers instead of concealing the gap. */
export const OPUS2_FLAG_TALKSPURT = 0x01

export type Opus2Frame = { frameNo: number; data: Buffer }
export type Opus2Packet = { flags: number; frames: Opus2Frame[] }

/**
 * KIND_OPUS2 payload: frameNo(u32) flags(u8) count(u8) then `count` × [len(u16) opus],
 * newest first: frames[i] is frame number frameNo - i. Redundant older copies let the receiver
 * rebuild a lost packet from the next one.
 */
export function encodeOpus2(frameNo: number, flags: number, frames: Buffer[]): Buffer {
  let size = 6
  for (const f of frames) size += 2 + f.length
  const out = Buffer.alloc(size)
  out.writeUInt32BE(frameNo >>> 0, 0)
  out.writeUInt8(flags & 0xff, 4)
  out.writeUInt8(frames.length, 5)
  let off = 6
  for (const f of frames) {
    out.writeUInt16BE(f.length, off)
    f.copy(out, off + 2)
    off += 2 + f.length
  }
  return out
}

export function decodeOpus2(payload: Buffer): Opus2Packet | null {
  if (payload.length < 6) return null
  const frameNo = payload.readUInt32BE(0)
  const flags = payload.readUInt8(4)
  const count = payload.readUInt8(5)
  if (count === 0 || count > 4) return null
  const frames: Opus2Frame[] = []
  let off = 6
  for (let i = 0; i < count; i += 1) {
    if (off + 2 > payload.length) return null
    const len = payload.readUInt16BE(off)
    if (len === 0 || off + 2 + len > payload.length) return null
    frames.push({ frameNo: (frameNo - i) >>> 0, data: payload.subarray(off + 2, off + 2 + len) })
    off += 2 + len
  }
  return { flags, frames }
}

/** Receive-quality report carried by probes and probe acks (all values clamped to u16). */
export type LinkReport = { lossPermille: number; jitterMs: number; bufferMs: number }

/** KIND_PROBE payload: clientMs(u32) + the client's downlink report. */
export function encodeProbe(clientMs: number, report: LinkReport): Buffer {
  const out = Buffer.alloc(10)
  out.writeUInt32BE(clientMs >>> 0, 0)
  writeReport(out, 4, report)
  return out
}

export function decodeProbe(payload: Buffer): { clientMs: number; report: LinkReport } | null {
  if (payload.length < 10) return null
  return { clientMs: payload.readUInt32BE(0), report: readReport(payload, 4) }
}

/** KIND_PROBE_ACK payload: echoed clientMs(u32) + the server's view of the client's uplink. */
export const encodeProbeAck = encodeProbe
export const decodeProbeAck = decodeProbe

const u16 = (v: number) => Math.max(0, Math.min(65535, Math.round(v)))

function writeReport(buf: Buffer, off: number, r: LinkReport) {
  buf.writeUInt16BE(u16(r.lossPermille), off)
  buf.writeUInt16BE(u16(r.jitterMs), off + 2)
  buf.writeUInt16BE(u16(r.bufferMs), off + 4)
}

function readReport(buf: Buffer, off: number): LinkReport {
  return { lossPermille: buf.readUInt16BE(off), jitterMs: buf.readUInt16BE(off + 2), bufferMs: buf.readUInt16BE(off + 4) }
}

/**
 * Replay/duplicate filter that, unlike "seq must grow", accepts packets reordered by the network
 * (the old check silently dropped every reordered packet and counted it as loss).
 */
export class ReplayWindow {
  private static readonly SIZE = 256
  private readonly seen = new Float64Array(ReplayWindow.SIZE).fill(-1)
  private highest = -1

  reset() {
    this.seen.fill(-1)
    this.highest = -1
  }

  /** Returns false for duplicates and packets older than the window. */
  accept(seq: number): boolean {
    if (this.highest >= 0 && seq + ReplayWindow.SIZE <= this.highest) return false
    const slot = seq % ReplayWindow.SIZE
    if (this.seen[slot] === seq) return false
    this.seen[slot] = seq
    if (seq > this.highest) this.highest = seq
    return true
  }
}
