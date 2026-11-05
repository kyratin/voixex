/** Camera v1: independently decodable JPEG frames. Encrypted by the media envelope.
 * Fixed 24-byte header, followed by <= 900 bytes. Complete datagrams stay below MTU.
 * Server prefixes downlink payloads with u8 UTF-8 identity length + authenticated identity.
 */
export const CAMERA_KIND = 6
export const CAMERA_CHUNK = 900
export const CAMERA_MAX_FRAME = 96 * 1024
export const CAMERA_HEADER = 24
export type CameraFragment = { stream: number; frame: number; timestamp: number; total: number; index: number; count: number; data: Uint8Array }
export function fragmentCamera(data: Uint8Array, stream: number, frame: number, timestamp: number): Uint8Array[] {
  if (!data.length || data.length > CAMERA_MAX_FRAME) throw new Error("Camera frame exceeds limit")
  const count = Math.ceil(data.length / CAMERA_CHUNK)
  return Array.from({ length: count }, (_, index) => {
    const chunk = data.subarray(index * CAMERA_CHUNK, (index + 1) * CAMERA_CHUNK)
    const out = new Uint8Array(CAMERA_HEADER + chunk.length)
    const v = new DataView(out.buffer)
    out.set([0x56, 0x43, 1, 1]) // magic, version, JPEG codec
    v.setUint32(4, stream >>> 0); v.setUint32(8, frame >>> 0)
    v.setUint32(12, timestamp >>> 0); v.setUint32(16, data.length)
    v.setUint16(20, index); v.setUint16(22, count)
    out.set(chunk, CAMERA_HEADER)
    return out
  })
}
export function parseCameraFragment(packet: Uint8Array): CameraFragment | null {
  if (packet.length <= CAMERA_HEADER || packet.length > CAMERA_HEADER + CAMERA_CHUNK || packet[0] !== 0x56 || packet[1] !== 0x43 || packet[2] !== 1 || packet[3] !== 1) return null
  const v = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  const total = v.getUint32(16), index = v.getUint16(20), count = v.getUint16(22)
  if (!total || total > CAMERA_MAX_FRAME || count !== Math.ceil(total / CAMERA_CHUNK) || index >= count) return null
  const expected = Math.min(CAMERA_CHUNK, total - index * CAMERA_CHUNK)
  if (packet.length !== CAMERA_HEADER + expected) return null
  return { stream: v.getUint32(4), frame: v.getUint32(8), timestamp: v.getUint32(12), total, index, count, data: packet.subarray(CAMERA_HEADER) }
}
type Pending = { sender: string; fragment: CameraFragment; created: number; chunks: Map<number, Uint8Array> }
/** Bounded assembly: at most two incomplete frames per sender, 64 senders, 500 ms. */
export class CameraAssembler {
  private pending = new Map<string, Pending>()
  private latest = new Map<string, { stream: number; frame: number; timestamp: number }>()
  clear() { this.pending.clear(); this.latest.clear() }
  push(sender: string, packet: Uint8Array, now: number): Uint8Array | null {
    for (const [key, value] of this.pending) if (now - value.created > 500) this.pending.delete(key)
    const f = parseCameraFragment(packet)
    if (!f || !sender || sender.length > 255) return null
    const last = this.latest.get(sender)
    if (last && (last.stream === f.stream ? ((f.frame - last.frame) | 0) <= 0 : ((f.timestamp - last.timestamp) | 0) <= 0)) return null
    const key = `${sender}:${f.stream}:${f.frame}`
    let entry = this.pending.get(key)
    if (!entry) {
      const owned = [...this.pending].filter(([, value]) => value.sender === sender).map(([key]) => key)
      while (owned.length >= 2) this.pending.delete(owned.shift()!)
      while (this.pending.size >= 128) this.pending.delete(this.pending.keys().next().value!)
      entry = { sender, fragment: f, created: now, chunks: new Map() }
      this.pending.set(key, entry)
    }
    const original = entry.fragment
    if (f.total !== original.total || f.count !== original.count || f.timestamp !== original.timestamp) return null
    entry.chunks.set(f.index, f.data.slice())
    if (entry.chunks.size !== f.count) return null
    const frame = new Uint8Array(f.total)
    for (const [index, data] of entry.chunks) frame.set(data, index * CAMERA_CHUNK)
    this.pending.delete(key)
    // JPEG only. Reject invalid format before allocating a decoder/browser image.
    if (frame[0] !== 0xff || frame[1] !== 0xd8 || frame[frame.length - 2] !== 0xff || frame[frame.length - 1] !== 0xd9) return null
    if (this.latest.size >= 64 && !this.latest.has(sender)) this.latest.delete(this.latest.keys().next().value!)
    this.latest.set(sender, { stream: f.stream, frame: f.frame, timestamp: f.timestamp })
    return frame
  }
}
