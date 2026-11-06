import { FRAME_SAMPLES } from './protocol.js'
export type Source = { clientId: string; frame: Int16Array }
/** Sum once, then subtract self and apply sparse custom-gain deltas before clipping. */
export class RoomMix {
  private readonly sum = new Float32Array(FRAME_SAMPLES)
  readonly sources = new Map<string, Int16Array>()
  constructor(sources: Source[]) {
    for (const {clientId, frame} of sources) {
      this.sources.set(clientId, frame)
      for (let i = 0; i < FRAME_SAMPLES; i++) this.sum[i] += frame[i]
    }
  }
  forListener(id: string, gains?: Map<string, number>) {
    const out = new Float32Array(this.sum)
    let used = this.sources.size
    const own = this.sources.get(id)
    if (own) { used--; for (let i = 0; i < FRAME_SAMPLES; i++) out[i] -= own[i] }
    if (gains) for (const [sourceId, gain] of gains) {
      if (sourceId === id || gain === 1) continue
      const source = this.sources.get(sourceId)
      if (!source) continue
      if (gain <= 0) used--
      for (let i = 0; i < FRAME_SAMPLES; i++) out[i] += source[i] * (gain - 1)
    }
    return used > 0 ? out : null
  }
}
