import { test } from "node:test"
import assert from "node:assert/strict"
import { OpusCodec } from "../src/opus-codec.js"

function tone(frequency: number, tick = 0) {
  const pcm = Buffer.alloc(1920)
  for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(Math.sin((tick * 960 + i) * 2 * Math.PI * frequency / 48000) * 10000), i * 2)
  return pcm
}
function energy(pcm: Buffer) { let sum = 0; for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2; return Math.sqrt(sum / (pcm.length / 2)) }

test("Opus survives participant churn, concurrent codecs and packet-loss concealment", () => {
  const pairs: Array<[OpusCodec, OpusCodec]> = []
  try {
    for (let round = 0; round < 160; round++) {
      if (pairs.length < 12) pairs.push([new OpusCodec(48000, 1, OpusCodec.Application.VOIP), new OpusCodec(48000, 1, OpusCodec.Application.VOIP)])
      for (const [index, [encoder, decoder]] of pairs.entries()) {
        const packet = encoder.encode(tone(300 + index * 100, round), 960)
        const pcm = decoder.decode(packet)
        assert.equal(pcm.length, 1920)
        assert.ok(energy(pcm) > 500, "decoded tone must remain audible")
        const plc = decoder.decode(Buffer.alloc(0))
        assert.equal(plc.length, 1920, "concealment must remain one 20 ms frame")
        assert.ok(energy(plc) > 500)
      }
      if (round % 3 === 0 && pairs.length > 3) for (const codec of pairs.splice(Math.floor(pairs.length / 2), 1)[0]) codec.delete()
    }
  } finally { for (const pair of pairs) for (const codec of pair) { codec.delete(); codec.delete() } }
})

test("invalid input does not poison other codecs", () => {
  const a = new OpusCodec(48000, 1, OpusCodec.Application.VOIP), b = new OpusCodec(48000, 1, OpusCodec.Application.VOIP)
  try {
    assert.throws(() => a.encode(Buffer.alloc(4), 960))
    assert.throws(() => a.decode(Buffer.alloc(4000)))
    assert.equal(b.decode(a.encode(tone(440), 960)).length, 1920)
    a.delete()
    assert.throws(() => a.encode(tone(440), 960), /closed/)
    assert.equal(b.decode(b.encode(tone(660), 960)).length, 1920)
  } finally { a.delete(); b.delete() }
})
