import { OpusCodec } from './opus-codec.js'
import { FRAME_SAMPLES, OPUS2_FLAG_TALKSPURT } from './protocol.js'
type Group = { epoch: number; encoder: OpusCodec; frame: number; at: number; frames: Buffer[]; flags: number }
/** Explicit stream epochs let capable receivers reset and prime before switching shared mixes. */
export class SharedMixes {
  private groups = new Map<string, Group>()
  private epoch = 0
  constructor(private readonly maxGroups = 256) {}
  encode(key: string, pcm: Int16Array, frame: number, now: number, bitrate: number, loss: number) {
    let group = this.groups.get(key)
    if (!group) {
      if (this.groups.size >= this.maxGroups) {
        const oldest = [...this.groups].filter(([,g]) => now - g.at > 100).sort((a,b) => a[1].at - b[1].at)[0]
        if (!oldest) return null
        oldest[1].encoder.delete();this.groups.delete(oldest[0])
      }
      const encoder = new OpusCodec(48000,1,OpusCodec.Application.VOIP)
      encoder.setBitrate(bitrate)
      for (const [ctl,value] of [[4010,8],[4024,3001],[4006,1],[4014,loss]]) encoder.encoderCTL(ctl,value)
      group = {epoch:++this.epoch,encoder,frame:-1,at:now,frames:[],flags:0}
      this.groups.set(key,group)
    }
    if (group.frame !== frame) {
      const continuous = group.frame === frame - 1 && now - group.at < 80
      if (!continuous) group.frames = []
      let data: Buffer
      try {
        data = group.encoder.encode(Buffer.from(pcm.buffer,pcm.byteOffset,pcm.byteLength),FRAME_SAMPLES)
      } catch (error) {
        // A failed predictor must never be reused under the same advertised epoch.
        this.groups.delete(key)
        try { group.encoder.delete() } catch { /* already failed */ }
        throw error
      }
      group.frames = [data,...group.frames].slice(0,5)
      group.flags = continuous ? 0 : OPUS2_FLAG_TALKSPURT
      group.frame = frame
    }
    group.at = now
    return group
  }
  sweep(now: number) {
    for (const [key,group] of this.groups) if (now - group.at > 5000) { group.encoder.delete();this.groups.delete(key) }
  }
  clear() { for (const group of this.groups.values()) group.encoder.delete();this.groups.clear() }
}
