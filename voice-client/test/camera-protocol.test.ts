import { test } from "node:test"
import assert from "node:assert/strict"
import { CameraAssembler, fragmentCamera, parseCameraFragment, CAMERA_MAX_FRAME } from "../src/camera-protocol.js"

function jpeg(size = 4000) { const bytes = new Uint8Array(size).fill(47); bytes.set([255, 216]); bytes.set([255, 217], size - 2); return bytes }

test("out of order fragments and duplicates reconstruct exact bytes", () => {
  const input = jpeg(), packets = fragmentCamera(input, 1, 10, 1000), receiver = new CameraAssembler()
  assert.equal(receiver.push("alice", packets[2], 0), null)
  assert.equal(receiver.push("alice", packets[2], 1), null)
  let output: Uint8Array | null = null
  for (const packet of packets.filter((_, index) => index !== 2).reverse()) output = receiver.push("alice", packet, 2) ?? output
  assert.deepEqual(output, input)
  for (const packet of packets) assert.equal(receiver.push("alice", packet, 3), null)
})

test("lost frames expire; next independent frame recovers", () => {
  const receiver = new CameraAssembler(), first = fragmentCamera(jpeg(), 1, 1, 1000)
  receiver.push("alice", first[0], 0)
  for (const packet of first.slice(1)) assert.equal(receiver.push("alice", packet, 501), null)
  let result: Uint8Array | null = null
  for (const packet of fragmentCamera(jpeg(), 1, 2, 2000)) result = receiver.push("alice", packet, 510) ?? result
  assert.deepEqual(result, jpeg())
})

test("bounds, malformed headers, conflicting metadata and JPEG validation", () => {
  assert.throws(() => fragmentCamera(new Uint8Array(CAMERA_MAX_FRAME + 1), 1, 1, 0))
  assert.throws(() => fragmentCamera(new Uint8Array(), 1, 1, 0))
  const packets = fragmentCamera(jpeg(), 1, 1, 0), corrupt = packets[0].slice()
  corrupt[23] = 255
  assert.equal(parseCameraFragment(corrupt), null)
  assert.equal(parseCameraFragment(packets[0].subarray(0, 24)), null)
  const receiver = new CameraAssembler()
  receiver.push("alice", packets[0], 0)
  const inconsistent = packets[1].slice(); new DataView(inconsistent.buffer).setUint32(12, 5)
  assert.equal(receiver.push("alice", inconsistent, 1), null)
  for (const packet of fragmentCamera(new Uint8Array(20), 2, 1, 0)) assert.equal(receiver.push("alice", packet, 2), null)
})

test("multiple senders are isolated; stale streams cannot replace a newer camera", () => {
  const receiver = new CameraAssembler(), a = fragmentCamera(jpeg(2000), 1, 1, 1000), b = fragmentCamera(jpeg(3000), 1, 1, 1000)
  let resultA: Uint8Array | null = null, resultB: Uint8Array | null = null
  for (let i = 0; i < b.length; i++) {
    if (a[i]) resultA = receiver.push("a", a[i], 0) ?? resultA
    resultB = receiver.push("a:other", b[i], 0) ?? resultB
  }
  assert.deepEqual(resultA, jpeg(2000)); assert.deepEqual(resultB, jpeg(3000))
  const newer = fragmentCamera(jpeg(20), 2, 0, 2000)
  assert.deepEqual(receiver.push("a", newer[0], 1), jpeg(20))
  for (const packet of fragmentCamera(jpeg(), 1, 100, 1500)) assert.equal(receiver.push("a", packet, 2), null)
  receiver.clear()
  assert.deepEqual(receiver.push("a", newer[0], 3), jpeg(20))
})

test("serial numbers wrap without accepting older frames", () => {
  const receiver = new CameraAssembler()
  assert.ok(receiver.push("a", fragmentCamera(jpeg(20), 1, 0xffffffff, 1000)[0], 0))
  assert.ok(receiver.push("a", fragmentCamera(jpeg(20), 1, 0, 1001)[0], 1))
  assert.equal(receiver.push("a", fragmentCamera(jpeg(20), 1, 0xffffffff, 1000)[0], 2), null)
})
