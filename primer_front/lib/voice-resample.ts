/** Linear resample state for uplink float chunks (matches previous page.tsx behavior but extracted). */
export type FloatResampleState = {
  txResampleInput: Float32Array
  txResamplePos: number
}

/**
 * If rates match within epsilon, returns chunk unchanged (same buffer reference).
 */
export function resampleFloat32Chunk(
  chunk: Float32Array,
  inRate: number,
  outRate: number,
  runtime: FloatResampleState
): Float32Array {
  if (Math.abs(inRate - outRate) < 0.5) return chunk
  const combined = new Float32Array(runtime.txResampleInput.length + chunk.length)
  combined.set(runtime.txResampleInput, 0)
  combined.set(chunk, runtime.txResampleInput.length)
  const step = inRate / outRate
  let pos = runtime.txResamplePos
  const out: number[] = []
  while (pos + 1 < combined.length) {
    const i = Math.floor(pos)
    const frac = pos - i
    const sample = combined[i] * (1 - frac) + combined[i + 1] * frac
    out.push(sample)
    pos += step
  }
  const keepFrom = Math.max(0, Math.floor(pos) - 1)
  runtime.txResampleInput = combined.subarray(keepFrom)
  runtime.txResamplePos = pos - keepFrom
  return Float32Array.from(out)
}

/**
 * Cubic Hermite interpolation between four samples for smoother resampling than linear.
 */
function cubicHermite(y0: number, y1: number, y2: number, y3: number, t: number): number {
  const c0 = y1
  const c1 = 0.5 * (y2 - y0)
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2)
  return ((c3 * t + c2) * t + c1) * t + c0
}

function getSampleClamped(frame: Int16Array, idx: number): number {
  if (idx < 0) return frame[0] ?? 0
  if (idx >= frame.length) return frame[frame.length - 1] ?? 0
  return frame[idx]
}

/**
 * Int16 PCM resample for downlink. Skips work when rates match.
 */
export function resampleInt16Frame(frame: Int16Array, inRate: number, outRate: number): Int16Array {
  if (Math.abs(inRate - outRate) < 0.5) return frame
  const outLen = Math.max(1, Math.round((frame.length * outRate) / inRate))
  const out = new Int16Array(outLen)
  const step = inRate / outRate
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * step
    const idx = Math.floor(pos)
    const t = pos - idx
    const y0 = getSampleClamped(frame, idx - 1)
    const y1 = getSampleClamped(frame, idx)
    const y2 = getSampleClamped(frame, idx + 1)
    const y3 = getSampleClamped(frame, idx + 2)
    const f0 = y0 / 32768
    const f1 = y1 / 32768
    const f2 = y2 / 32768
    const f3 = y3 / 32768
    const s = cubicHermite(f0, f1, f2, f3, t)
    const clamped = Math.max(-1, Math.min(1, s))
    out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
  }
  return out
}
