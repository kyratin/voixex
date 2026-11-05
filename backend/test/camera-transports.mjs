// Runs in its own process because the production media mixer owns recurring timers.
import assert from "node:assert/strict"
import net from "node:net"
import http from "node:http"
import { randomBytes } from "node:crypto"
import { WebSocketServer } from "ws"

const reservation = net.createServer()
await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
process.env.UDP_HOST = "127.0.0.1"
process.env.UDP_PORT = String(port)
process.env.TOKEN_SECRET = "camera-integration-test"
const media = await import("../dist/media/core.js")
const { makeMediaToken } = await import("../dist/token.js")
// CAMERA_CLIENT_ROOT may point at an independently checked out client branch.
const { VoiceEngine } = await import(`${process.env.CAMERA_CLIENT_ROOT}/voice-client/dist/index.js`)
const { fragmentCamera, CameraAssembler } = await import("../dist/media/camera-protocol.js")
const { readFileSync } = await import("node:fs")
assert.equal(readFileSync(new URL("../src/media/camera-protocol.ts", import.meta.url), "utf8"), readFileSync(`${process.env.CAMERA_CLIENT_ROOT}/voice-client/src/camera-protocol.ts`, "utf8"), "client and server protocol definitions must match")
const clients = []
let browserPeers
const server = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*")
  response.setHeader("Content-Type", "application/json")
  if (request.url === "/test/token") {
    const seed = randomBytes(32).toString("base64"), id = "browser-camera"
    media.setMemberRoom(id, "room-a"); media.setMemberCameraAllowed(id, true)
    const mediaToken = makeMediaToken({ serverId: "server-a", clientId: id, mediaSeed: seed }, process.env.TOKEN_SECRET)
    response.end(JSON.stringify({ apiBase, mediaToken })); return
  }
  if (request.url === "/test/frames") {
    response.end(JSON.stringify(browserPeers?.[1].frames.filter(f => f.sender === "browser-camera").map(f => Buffer.from(f.frame).toString("base64")) ?? [])); return
  }
  if (request.url === "/test/send") {
    for (const packet of fragmentCamera(jpeg(9000), 300, 1, 3000)) { browserPeers[1].engine.sendCameraPacket(Buffer.from(packet)); await pause(2) }
    response.end("{}"); return
  }
  response.statusCode = 404; response.end("{}")
})
const wss = new WebSocketServer({ server })
let wsId = 0
wss.on("connection", socket => {
  const id = `test-${wsId++}`
  media.wsOpen(id, id, data => socket.send(data), () => socket.close())
  socket.on("message", data => media.wsData(id, Buffer.from(data)))
  socket.on("close", () => media.wsClose(id))
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const apiBase = `http://127.0.0.1:${server.address().port}`
media.startMedia({ info() {}, warn() {}, debug() {} }, {})
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(predicate, message) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await pause(20) }
  assert.fail(message)
}
function jpeg(size) { const data = new Uint8Array(size).fill(33); data.set([255, 216]); data.set([255, 217], size - 2); return data }
async function client(id, transport, room = "room-a") {
  const seed = randomBytes(32).toString("base64")
  const token = makeMediaToken({ serverId: "server-a", clientId: id, mediaSeed: seed }, process.env.TOKEN_SECRET)
  media.setMemberRoom(id, room)
  media.setMemberCameraAllowed(id, true)
  const engine = new VoiceEngine({ host: "127.0.0.1", port, apiBase, mediaToken: token, mediaSeed: seed, transport })
  clients.push(engine)
  const frames = [], assembler = new CameraAssembler()
  engine.setOnCameraPacket(packet => {
    const n = packet[0], sender = packet.subarray(1, n + 1).toString()
    const frame = assembler.push(sender, packet.subarray(n + 1), performance.now())
    if (frame) frames.push({ sender, frame })
  })
  await engine.connect(); engine.joinRoom(room)
  return { id, engine, frames }
}
let success = false
try {
  const peers = []
  for (const transport of ["udp", "tcp", "ws"]) peers.push(await client(`peer-${transport}`, transport))
  const outsider = await client("outsider", "ws", "other-room")
  const frame = jpeg(9000)
  for (let i = 0; i < peers.length; i++) {
    const sender = peers[i]
    for (const packet of fragmentCamera(frame, 1, i, 1000 + i)) { sender.engine.sendCameraPacket(Buffer.from(packet)); await pause(2) }
    for (const receiver of peers.filter(p => p !== sender)) {
      await waitFor(() => receiver.frames.some(f => f.sender === sender.id), `${sender.id} → ${receiver.id}`)
      assert.deepEqual(receiver.frames.find(f => f.sender === sender.id).frame, frame)
      console.log(`PASS ${sender.id} → ${receiver.id}: authenticated sender, exact frame`)
    }
  }
  assert.equal(outsider.frames.length, 0, "camera must not cross rooms")
  const burstBefore = peers[2].frames.filter(f => f.sender === peers[1].id).length
  for (let frameId = 0; frameId < 45; frameId++) {
    for (const packet of fragmentCamera(frame, 500, frameId, 5000 + frameId)) peers[1].engine.sendCameraPacket(Buffer.from(packet))
    await pause(4)
  }
  await waitFor(() => peers[2].frames.filter(f => f.sender === peers[1].id).length === burstBefore + 45, "30 fps compatibility burst must fit the increased sender budget")
  console.log("PASS >256 KiB camera burst without frame loss under the 1 MiB/s budget")
  const before = peers[1].frames.length
  media.setMemberCameraAllowed(peers[0].id, false)
  for (const packet of fragmentCamera(frame, 1, 100, 2000)) peers[0].engine.sendCameraPacket(Buffer.from(packet))
  await pause(150)
  assert.equal(peers[1].frames.length, before, "server must enforce camera permission")
  media.setMemberCameraAllowed(peers[0].id, true)
  media.setMemberFlags(peers[0].id, true, false)
  for (const packet of fragmentCamera(frame, 1, 101, 2001)) { peers[0].engine.sendCameraPacket(Buffer.from(packet)); await pause(2) }
  await waitFor(() => peers[1].frames.length > before, "microphone mute must not mute video")
  media.setMemberRoom(peers[0].id, "other-room")
  const oldRoomCount = peers[1].frames.length
  for (const packet of fragmentCamera(frame, 1, 102, 2002)) peers[0].engine.sendCameraPacket(Buffer.from(packet))
  await pause(150)
  assert.equal(peers[1].frames.length, oldRoomCount, "old room packets must be rejected")
  console.log("PASS room isolation, policy revocation, muted microphone, stale room packets")
  success = true
  if (process.env.CAMERA_BROWSER === "1") {
    browserPeers = peers
    console.log(`BROWSER_RELAY_READY ${apiBase}`)
    await new Promise(resolve => process.once("SIGTERM", resolve))
  }
} catch (error) { console.error(error) }
finally {
  for (const client of clients) client.close()
  for (const socket of wss.clients) socket.terminate()
  server.close()
  setTimeout(() => process.exit(success ? 0 : 1), 50)
}
