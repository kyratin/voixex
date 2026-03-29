/** EBML header element id (WebM/Matroska). */
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const
/** Cluster element id (first media segment in WebM). */
const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75] as const

/**
 * If `buf` starts with a WebM EBML header, returns bytes from start up to (but not including)
 * the first top-level Cluster element — suitable as an MSE initialization segment prefix.
 * If no Cluster is found, returns a copy of the full buffer (fallback).
 * If the buffer does not start with EBML, returns null.
 */
export function extractWebmInitPrefix(buf: Uint8Array): Uint8Array | null {
  if (buf.length < 4) return null
  for (let j = 0; j < 4; j++) {
    if (buf[j] !== EBML_MAGIC[j]) return null
  }
  for (let i = 4; i <= buf.length - 4; i++) {
    if (
      buf[i] === CLUSTER_ID[0] &&
      buf[i + 1] === CLUSTER_ID[1] &&
      buf[i + 2] === CLUSTER_ID[2] &&
      buf[i + 3] === CLUSTER_ID[3]
    ) {
      return buf.subarray(0, i)
    }
  }
  return new Uint8Array(buf)
}
