/**
 * Browser port of the voice media protocol (backend/src/media/protocol.ts): same packet layout,
 * AES-256-GCM via WebCrypto instead of node:crypto.
 *
 *   magic(3) seq(u32) ts(u32) roomLen(u8) room nonce(12) tagLen(u16) | AES-GCM( kind(u8) payload ) | tag
 */
export const KIND_PCM = 0
export const KIND_OPUS2 = 3
export const KIND_PROBE = 4
export const KIND_PROBE_ACK = 5

export const FRAME_MS = 20
export const SAMPLE_RATE = 48_000
export const FRAME_SAMPLES = 960
export const OPUS2_FLAG_TALKSPURT = 0x01

const MAGIC = [0x56, 0x50, 0x01]
const TAG_LEN = 16
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export async function deriveMediaKey(mediaSeedB64: string): Promise<CryptoKey> {
  const seed = Uint8Array.from(atob(mediaSeedB64), (c) => c.charCodeAt(0))
  const base = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("voip-salt"), info: encoder.encode("media-key") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

export async function encryptPacket(key: CryptoKey, seq: number, ts: number, roomId: string, payload: Uint8Array, kind: number) {
  const room = encoder.encode(roomId)
  const nonce = new Uint8Array(12)
  const nv = new DataView(nonce.buffer)
  nv.setUint32(0, ts >>> 0)
  nv.setUint32(4, seq >>> 0)
  crypto.getRandomValues(nonce.subarray(8))
  const plain = new Uint8Array(1 + payload.length)
  plain[0] = kind & 0xff
  plain.set(payload, 1)
  // WebCrypto returns ciphertext || tag, which is exactly the wire order.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: TAG_LEN * 8 }, key, plain))
  const headerLen = 3 + 4 + 4 + 1 + room.length + 12 + 2
  const out = new Uint8Array(headerLen + sealed.length)
  const v = new DataView(out.buffer)
  out.set(MAGIC, 0)
  v.setUint32(3, seq >>> 0)
  v.setUint32(7, ts >>> 0)
  out[11] = room.length
  out.set(room, 12)
  out.set(nonce, 12 + room.length)
  v.setUint16(12 + room.length + 12, TAG_LEN)
  out.set(sealed, headerLen)
  return out
}

export type DecryptedPacket = { seq: number; ts: number; roomId: string; kind: number; payload: Uint8Array }

export async function decryptPacket(key: CryptoKey, packet: Uint8Array): Promise<DecryptedPacket | null> {
  if (packet.length < 3 + 4 + 4 + 1 + 12 + 2 + TAG_LEN) return null
  if (packet[0] !== MAGIC[0] || packet[1] !== MAGIC[1] || packet[2] !== MAGIC[2]) return null
  const v = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  const seq = v.getUint32(3)
  const ts = v.getUint32(7)
  const roomEnd = 12 + packet[11]
  const nonceEnd = roomEnd + 12
  if (nonceEnd + 2 > packet.length || v.getUint16(nonceEnd) !== TAG_LEN) return null
  const encStart = nonceEnd + 2
  if (packet.length - encStart <= TAG_LEN) return null
  let plain: Uint8Array
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: packet.slice(roomEnd, nonceEnd), tagLength: TAG_LEN * 8 },
        key,
        packet.slice(encStart)
      )
    )
  } catch {
    return null
  }
  if (plain.length < 1) return null
  return { seq, ts, roomId: decoder.decode(packet.subarray(12, roomEnd)), kind: plain[0], payload: plain.subarray(1) }
}

/** KIND_OPUS2 payload: frameNo(u32) flags(u8) count(u8) then count × [len(u16) opus], newest first. */
export function encodeOpus2(frameNo: number, flags: number, frames: Uint8Array[]) {
  let size = 6
  for (const f of frames) size += 2 + f.length
  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  v.setUint32(0, frameNo >>> 0)
  out[4] = flags & 0xff
  out[5] = frames.length
  let off = 6
  for (const f of frames) {
    v.setUint16(off, f.length)
    out.set(f, off + 2)
    off += 2 + f.length
  }
  return out
}

export function decodeOpus2(payload: Uint8Array): { flags: number; frames: Array<{ frameNo: number; data: Uint8Array }> } | null {
  if (payload.length < 6) return null
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const frameNo = v.getUint32(0)
  const count = payload[5]
  if (count === 0 || count > 4) return null
  const frames: Array<{ frameNo: number; data: Uint8Array }> = []
  let off = 6
  for (let i = 0; i < count; i += 1) {
    if (off + 2 > payload.length) return null
    const len = v.getUint16(off)
    if (len === 0 || off + 2 + len > payload.length) return null
    frames.push({ frameNo: (frameNo - i) >>> 0, data: payload.slice(off + 2, off + 2 + len) })
    off += 2 + len
  }
  return { flags: payload[4], frames }
}

export type LinkReport = { lossPermille: number; jitterMs: number; bufferMs: number }

const u16 = (x: number) => Math.max(0, Math.min(65535, Math.round(x)))

/** KIND_PROBE / KIND_PROBE_ACK payload: clientMs(u32) + a receive-quality report. */
export function encodeProbe(clientMs: number, r: LinkReport) {
  const out = new Uint8Array(10)
  const v = new DataView(out.buffer)
  v.setUint32(0, clientMs >>> 0)
  v.setUint16(4, u16(r.lossPermille))
  v.setUint16(6, u16(r.jitterMs))
  v.setUint16(8, u16(r.bufferMs))
  return out
}

export function decodeProbe(payload: Uint8Array): { clientMs: number; report: LinkReport } | null {
  if (payload.length < 10) return null
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  return { clientMs: v.getUint32(0), report: { lossPermille: v.getUint16(4), jitterMs: v.getUint16(6), bufferMs: v.getUint16(8) } }
}

export const textOf = (data: Uint8Array) => decoder.decode(data)
export const bytesOf = (text: string) => encoder.encode(text)
