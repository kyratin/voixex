/** Queue regression with the actual browser engine and real WebCrypto, without a network service. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'
import { build } from 'esbuild'

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = await mkdtemp(join(tmpdir(), 'voixex-send-queue-'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label) {
  const deadline = Date.now() + 2000
  while (!check() && Date.now() < deadline) await delay(5)
  assert.ok(check(), label)
}
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
if (!globalThis.WebSocket) globalThis.WebSocket = { OPEN: 1 }
let engine
try {
  const bundle = join(output, 'engine.mjs')
  await build({
    stdin: {
      contents: [
        'export { WebVoiceEngine } from "./lib/web-voice/engine.ts";',
        'export { deriveMediaKey, decryptPacket, KIND_OPUS2 } from "./lib/web-voice/protocol.ts";',
        'export { fragmentCamera, CAMERA_KIND } from "../voice-client/src/camera-protocol.ts";'
      ].join('\n'),
      resolveDir: frontend
    },
    bundle: true, platform: 'node', format: 'esm', outfile: bundle
  })
  const { WebVoiceEngine, deriveMediaKey, decryptPacket, fragmentCamera, KIND_OPUS2, CAMERA_KIND } = await import(pathToFileURL(bundle).href)
  const key = await deriveMediaKey(Buffer.alloc(32, 7).toString('base64'))
  const packets = []
  engine = new WebVoiceEngine()
  // TypeScript-private fields are intentionally injected to control backpressure deterministically.
  engine.key = key
  engine.roomId = 'room-a'
  engine.connected = true
  engine.cameraSupported = true
  engine.ws = { readyState: 1, bufferedAmount: 5000, send(packet) { packets.push(packet) }, close() {} }
  const jpeg = new Uint8Array(9000).fill(23)
  jpeg.set([255, 216]); jpeg.set([255, 217], jpeg.length - 2)
  for (const fragment of fragmentCamera(jpeg, 3, 1, 1)) await engine.sendCameraPacket(fragment)
  await engine.send(KIND_OPUS2, new Uint8Array([9]))
  engine.ws.bufferedAmount = 0
  engine.outgoing.drain()
  await until(() => packets.length === 11, 'audio and all ten JPEG fragments must be sent')
  const decoded = await Promise.all(packets.map(packet => decryptPacket(key, packet)))
  assert.ok(decoded.every(Boolean), 'all packets must decrypt')
  assert.equal(decoded[0].kind, KIND_OPUS2, 'voice must precede the camera backlog')
  assert.equal(decoded.filter(packet => packet.kind === CAMERA_KIND).length, 10)
  for (let i = 1; i < decoded.length; i++) assert.ok(decoded[i].seq > decoded[i - 1].seq, 'wire sequence must increase')
  console.log('PASS browser engine: voice outranks complete JPEG; WebCrypto sequence follows wire order')

  packets.length = 0
  engine.ws.bufferedAmount = 5000
  await engine.send(KIND_OPUS2, new Uint8Array([1]))
  await delay(110)
  engine.ws.bufferedAmount = 0
  engine.outgoing.drain()
  await delay(20)
  assert.equal(packets.length, 0, 'speech older than 80 ms must not be replayed')
  console.log('PASS browser engine: blocked speech expires instead of accumulating delay')

  await engine.send(KIND_OPUS2, new Uint8Array([2]))
  assert.ok(engine.sending, 'WebCrypto must be in flight before the room change')
  engine.joinRoom('room-b')
  await until(() => !engine.sending, 'previous-room encryption must finish')
  assert.equal(packets.length, 0, 'in-flight audio must not leak across rooms')
  console.log('PASS browser engine: room change cancels in-flight old-room encryption')
} finally {
  engine?.close()
  await rm(output, { recursive: true, force: true })
}
