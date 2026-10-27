import dgram, { type RemoteInfo } from "node:dgram"
import net, { type Socket } from "node:net"
import { randomUUID } from "node:crypto"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import OpusScript from "opusscript"
import { config } from "../config.js"
import { verifyToken } from "../token.js"
import { SpeakerStream, rms } from "./jitter.js"
import {
  FRAME_MS,
  FRAME_SAMPLES,
  KIND_OPUS,
  KIND_OPUS2,
  KIND_PCM,
  KIND_PROBE,
  KIND_PROBE_ACK,
  KIND_SCREEN,
  OPUS2_FLAG_TALKSPURT,
  ReplayWindow,
  SAMPLE_RATE,
  decodeOpus2,
  decodeProbe,
  decryptPacket,
  deriveMediaKey,
  encodeOpus2,
  encodeProbeAck,
  encryptPacket,
  type DecryptedPacket,
  type LinkReport
} from "./protocol.js"

export type MediaLogger = {
  info: (obj: object, msg?: string) => void
  warn: (obj: object, msg?: string) => void
  debug: (obj: object, msg?: string) => void
}

export type MediaHooks = {
  onSpeakingChanged?: (input: { clientId: string; speaking: boolean }) => void
  onSessionStale?: (input: { clientId: string }) => void
}

/** Capabilities a client announces in HELLO2 (space separated after the token). */
type Caps = { opus2: boolean }

type Session = {
  clientId: string
  roomId: string | null
  transport: "udp" | "tcp"
  remote?: { address: string; port: number }
  tcp?: { send: (packet: Buffer) => void; backlog: () => number } | null
  tcpLabel?: string
  key: Buffer
  caps: Caps
  replay: ReplayWindow
  seqOut: number
  packetCountSecond: number
  currentSecond: number
  muted: boolean
  deafened: boolean
  speaking: boolean
  lastLoudAtMs: number
  lastLegacyProbeAckAtMs: number
  lastPacketAtMs: number
  /** Uplink jitter buffer (this member speaking). */
  stream: SpeakerStream
  decoder: OpusScript | null
  /** Downlink Opus encoder (only for clients with opus2). */
  encoder: OpusScript | null
  /** Recent encoded downlink frames, newest first, for redundancy. */
  recentEncoded: Buffer[]
  lastTxFrameNo: number
  /** What the client last reported about its downlink, and what we see on its uplink. */
  downlink: LinkReport
  /** Uplink loss over the stats period: frames expected from the frame numbers vs. received. */
  uplinkLoss: { expected: number; received: number; highest: number }
  /** Old clients: packets that were not audio, so seq − this is the audio frame's slot. */
  legacyNonAudio: number
  downlinkBitrate: number
  redundancy: number
  stats: SessionStats
}

type SessionStats = {
  rxPackets: number
  txPackets: number
  rxBytes: number
  txBytes: number
  rxDuplicateDropped: number
  rxRateLimitDropped: number
  rxDecryptDropped: number
  rxRoomMismatchDropped: number
  rxAudioFrames: number
  txAudioFrames: number
  redundancyRecovered: number
  tcpBacklogDropped: number
}

const freshStats = (): SessionStats => ({
  rxPackets: 0,
  txPackets: 0,
  rxBytes: 0,
  txBytes: 0,
  rxDuplicateDropped: 0,
  rxRateLimitDropped: 0,
  rxDecryptDropped: 0,
  rxRoomMismatchDropped: 0,
  rxAudioFrames: 0,
  txAudioFrames: 0,
  redundancyRecovered: 0,
  tcpBacklogDropped: 0
})

/** Downlink bitrate steps (bits/s) chosen from the loss the client reports. */
const BITRATE_GOOD = 40_000
const BITRATE_LOSSY = 28_000
const BITRATE_BAD = 20_000
/** Above this much queued TCP data (≈ 0.5 s of audio) audio is skipped instead of piling up latency. */
const TCP_MAX_BACKLOG_BYTES = 24 * 1024
const SPEAKING_RMS = 0.02
const SPEAKING_HOLD_MS = 250

const sessions = new Map<string, Session>()
/** "address:port" → session, so a UDP packet is decrypted once instead of trying every key. */
const sessionsByRemote = new Map<string, Session>()
const desiredRoomByClient = new Map<string, string | null>()
const desiredFlagsByClient = new Map<string, { muted: boolean; deafened: boolean }>()
/** listenerClientId -> (targetClientId -> gain 0..2) */
const peerGainByListener = new Map<string, Map<string, number>>()
const screenChunksByRoom = new Map<string, Array<{ clientId: string; chunk: Buffer }>>()
/** Room timeline: downlink frame numbers follow mixer ticks so a pause shows up as a gap. */
const roomTick = new Map<string, number>()
const loopDelay = monitorEventLoopDelay({ resolution: 5 })
loopDelay.enable()

let logger: MediaLogger
let hooks: MediaHooks = {}
let udpSocket: dgram.Socket | null = null

export function setMemberRoom(clientId: string, roomId: string | null) {
  desiredRoomByClient.set(clientId, roomId)
  const s = sessions.get(clientId)
  if (s && s.roomId !== roomId) {
    s.roomId = roomId
    s.stream = newStream(s)
    s.recentEncoded = []
  }
}

export function setMemberFlags(clientId: string, muted: boolean, deafened: boolean) {
  desiredFlagsByClient.set(clientId, { muted, deafened })
  const s = sessions.get(clientId)
  if (!s) return
  s.muted = muted
  s.deafened = deafened
}

export function setMemberSpeaking(clientId: string, speaking: boolean) {
  const s = sessions.get(clientId)
  if (s) s.speaking = speaking
}

export function setPeerVolume(listenerClientId: string, targetClientId: string, volumePct: number) {
  const pct = Math.max(0, Math.min(200, Math.round(volumePct)))
  let m = peerGainByListener.get(listenerClientId)
  if (!m) {
    m = new Map()
    peerGainByListener.set(listenerClientId, m)
  }
  if (pct === 100) {
    m.delete(targetClientId)
    if (m.size === 0) peerGainByListener.delete(listenerClientId)
  } else {
    m.set(targetClientId, pct / 100)
  }
}

export function removeMember(clientId: string) {
  peerGainByListener.delete(clientId)
  for (const m of peerGainByListener.values()) m.delete(clientId)
  dropSession(clientId)
  desiredRoomByClient.delete(clientId)
  desiredFlagsByClient.delete(clientId)
}

function dropSession(clientId: string) {
  const s = sessions.get(clientId)
  if (!s) return
  if (s.remote) {
    const k = remoteKey(s.remote)
    if (sessionsByRemote.get(k) === s) sessionsByRemote.delete(k)
  }
  s.decoder?.delete()
  s.encoder?.delete()
  sessions.delete(clientId)
}

const remoteKey = (r: { address: string; port: number }) => `${r.address}:${r.port}`

function newStream(s: { decoder: OpusScript | null }) {
  return new SpeakerStream(() => {
    s.decoder ??= new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP)
    return s.decoder
  })
}

function parseHello(text: string): { token: string; caps: Caps } | null {
  if (text.startsWith("HELLO2 ")) {
    const [token, ...rest] = text.slice(7).trim().split(/\s+/)
    return { token, caps: { opus2: rest.includes("opus2") } }
  }
  if (text.startsWith("HELLO ")) return { token: text.slice(6).trim(), caps: { opus2: false } }
  return null
}

function acceptHello(
  text: string,
  transport: { kind: "udp"; remote: { address: string; port: number } } | { kind: "tcp"; tcp: NonNullable<Session["tcp"]>; label: string }
): { ok: true; session: Session; ack: Buffer } | { ok: false } {
  const hello = parseHello(text)
  if (!hello) return { ok: false }
  const payload = verifyToken(hello.token, config.tokenSecret)
  if (!payload || payload.sub !== "media" || !payload.mediaSeed) return { ok: false }
  const clientId = payload.clientId
  const existing = sessions.get(clientId)
  const now = Date.now()
  const sameEndpoint =
    existing &&
    existing.transport === transport.kind &&
    (transport.kind === "udp"
      ? existing.remote && remoteKey(existing.remote) === remoteKey(transport.remote)
      : existing.tcp === transport.tcp)
  // HELLO is repeated every few seconds as a keepalive; only a new endpoint is a new engine
  // whose packet numbers start again from 1.
  if (existing && sameEndpoint) {
    existing.caps = hello.caps
    existing.lastPacketAtMs = now
    return { ok: true, session: existing, ack: helloAck(hello.caps) }
  }
  if (existing) dropSession(clientId)
  const flags = desiredFlagsByClient.get(clientId)
  const session: Session = {
    clientId,
    roomId: desiredRoomByClient.get(clientId) ?? null,
    transport: transport.kind,
    remote: transport.kind === "udp" ? transport.remote : undefined,
    tcp: transport.kind === "tcp" ? transport.tcp : null,
    tcpLabel: transport.kind === "tcp" ? transport.label : undefined,
    key: deriveMediaKey(String(payload.mediaSeed)),
    caps: hello.caps,
    replay: new ReplayWindow(),
    seqOut: 1,
    packetCountSecond: 0,
    currentSecond: Math.floor(now / 1000),
    muted: flags?.muted ?? false,
    deafened: flags?.deafened ?? false,
    speaking: false,
    lastLoudAtMs: 0,
    lastLegacyProbeAckAtMs: 0,
    lastPacketAtMs: now,
    stream: null as unknown as SpeakerStream,
    decoder: null,
    encoder: null,
    recentEncoded: [],
    lastTxFrameNo: -1,
    downlink: { lossPermille: 0, jitterMs: 0, bufferMs: 0 },
    uplinkLoss: { expected: 0, received: 0, highest: -1 },
    legacyNonAudio: 0,
    downlinkBitrate: BITRATE_GOOD,
    // TCP is reliable: redundant copies would only add bytes.
    redundancy: transport.kind === "tcp" ? 0 : 1,
    stats: freshStats()
  }
  session.stream = newStream(session)
  sessions.set(clientId, session)
  if (session.remote) sessionsByRemote.set(remoteKey(session.remote), session)
  logger.info(
    { clientId, transport: transport.kind, remote: transport.kind === "udp" ? remoteKey(transport.remote) : transport.label, caps: hello.caps },
    "media session HELLO accepted"
  )
  return { ok: true, session, ack: helloAck(hello.caps) }
}

const helloAck = (caps: Caps) => Buffer.from(caps.opus2 ? "HELLO_ACK opus2" : "HELLO_ACK")

function send(session: Session, kind: number, payload: Buffer, ts = Date.now()) {
  if (!session.roomId && kind !== KIND_PROBE_ACK) return
  const packet = encryptPacket(session.key, session.seqOut++, ts, session.roomId ?? "", payload, kind)
  if (session.transport === "tcp") {
    if (!session.tcp) return
    if (kind !== KIND_PROBE_ACK && session.tcp.backlog() > TCP_MAX_BACKLOG_BYTES) {
      session.stats.tcpBacklogDropped += 1
      return
    }
    session.tcp.send(packet)
  } else {
    if (!session.remote || !udpSocket) return
    udpSocket.send(packet, session.remote.port, session.remote.address)
  }
  session.stats.txPackets += 1
  session.stats.txBytes += packet.length
}

function handlePacket(session: Session, decoded: DecryptedPacket, packetLength: number) {
  const now = Date.now()
  session.lastPacketAtMs = now
  const sec = Math.floor(now / 1000)
  if (sec !== session.currentSecond) {
    session.currentSecond = sec
    session.packetCountSecond = 0
  }
  if (++session.packetCountSecond > config.mediaRateLimitPerSec) {
    session.stats.rxRateLimitDropped += 1
    return
  }
  if (!session.replay.accept(decoded.seq)) {
    session.stats.rxDuplicateDropped += 1
    return
  }
  session.stats.rxPackets += 1
  session.stats.rxBytes += packetLength

  if (decoded.kind === KIND_PROBE) {
    const probe = decodeProbe(decoded.payload)
    if (!probe) return
    session.downlink = probe.report
    adaptDownlink(session)
    const ack = encodeProbeAck(probe.clientMs, {
      lossPermille: uplinkLossPct(session) * 10,
      jitterMs: session.stream.jitter,
      bufferMs: session.stream.targetFrames * FRAME_MS
    })
    // Answered right away (also outside a room) so the client measures a real round trip.
    send(session, KIND_PROBE_ACK, ack, decoded.ts)
    return
  }

  // Old clients measure their "ping" from an empty audio packet echoing their own timestamp.
  if (!session.caps.opus2 && session.roomId && decoded.roomId === session.roomId && now - session.lastLegacyProbeAckAtMs >= 1000) {
    session.lastLegacyProbeAckAtMs = now
    send(session, KIND_PCM, Buffer.alloc(0), decoded.ts)
  }

  if (!session.roomId || session.roomId !== decoded.roomId) {
    session.stats.rxRoomMismatchDropped += 1
    return
  }

  if (decoded.kind === KIND_SCREEN) {
    session.legacyNonAudio += 1
    const list = screenChunksByRoom.get(session.roomId) ?? []
    list.push({ clientId: session.clientId, chunk: decoded.payload })
    screenChunksByRoom.set(session.roomId, list)
    return
  }
  if (session.muted) return

  if (decoded.kind === KIND_OPUS2) {
    const packet = decodeOpus2(decoded.payload)
    if (!packet) return
    session.stats.rxAudioFrames += 1
    const loss = session.uplinkLoss
    const primary = packet.frames[0].frameNo
    if (primary > loss.highest) {
      const step = primary - loss.highest
      // A long jump is a pause (mute, silence), not loss.
      loss.expected += loss.highest < 0 || step >= 25 ? 1 : step
      loss.highest = primary
    }
    loss.received += 1
    packet.frames.forEach((f, i) => {
      const before = session.stream.depthFrames
      session.stream.push(
        { mode: "numbered", frameNo: f.frameNo, data: Buffer.from(f.data), primary: i === 0, talkspurt: i === 0 && (packet.flags & OPUS2_FLAG_TALKSPURT) !== 0 },
        now
      )
      if (i > 0 && session.stream.depthFrames > before) session.stats.redundancyRecovered += 1
    })
    return
  }

  if (decoded.kind === KIND_PCM || decoded.kind === KIND_OPUS) {
    if (decoded.payload.length === 0) return
    // Old clients' once-a-second keepalive is a frame of digital silence; queueing it would
    // insert a 20 ms hole into speech every second.
    if (decoded.kind === KIND_PCM && isAllZero(decoded.payload)) {
      session.legacyNonAudio += 1
      return
    }
    session.stats.rxAudioFrames += 1
    session.stream.push(
      {
        mode: "legacy",
        seq: decoded.seq,
        index: decoded.seq - session.legacyNonAudio,
        codec: decoded.kind === KIND_PCM ? "pcm" : "opus",
        data: Buffer.from(decoded.payload)
      },
      now
    )
  }
}

function uplinkLossPct(s: Session) {
  const { expected, received } = s.uplinkLoss
  return expected > 0 ? (Math.max(0, expected - received) * 100) / expected : 0
}

function isAllZero(buf: Buffer) {
  for (let i = 0; i < buf.length; i += 1) if (buf[i] !== 0) return false
  return true
}

/** Downlink bitrate and redundancy follow the loss the client reports. */
function adaptDownlink(session: Session) {
  if (!session.caps.opus2) return
  const loss = session.downlink.lossPermille / 10
  const bitrate = loss > 10 ? BITRATE_BAD : loss > 3 ? BITRATE_LOSSY : BITRATE_GOOD
  // TCP is reliable: redundancy would only add bytes.
  session.redundancy = session.transport === "tcp" ? 0 : loss > 3 ? 2 : 1
  if (bitrate !== session.downlinkBitrate && session.encoder) {
    session.encoder.setBitrate(bitrate)
    try {
      session.encoder.encoderCTL(4014, Math.min(30, Math.round(loss))) // OPUS_SET_PACKET_LOSS_PERC
    } catch {
      /* optional */
    }
  }
  session.downlinkBitrate = bitrate
}

function encoderFor(session: Session) {
  if (session.encoder) return session.encoder
  const enc = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP)
  enc.setBitrate(session.downlinkBitrate)
  for (const [ctl, value] of [
    [4010, 8], // OPUS_SET_COMPLEXITY
    [4024, 3001], // OPUS_SET_SIGNAL → voice
    [4006, 1] // OPUS_SET_VBR
  ] as const) {
    try {
      enc.encoderCTL(ctl, value)
    } catch {
      /* optional tuning */
    }
  }
  session.encoder = enc
  return enc
}

/** Sum with a soft knee instead of averaging: two people talking are not each halved. */
function mixInto(out: Float32Array, frame: Int16Array, gain: number) {
  for (let i = 0; i < FRAME_SAMPLES; i += 1) out[i] += frame[i] * gain
}

const KNEE = 24_000
function softClipToPcm(mix: Float32Array): Int16Array {
  const out = new Int16Array(FRAME_SAMPLES)
  for (let i = 0; i < FRAME_SAMPLES; i += 1) {
    const v = mix[i]
    const a = Math.abs(v)
    out[i] = a <= KNEE ? Math.round(v) : Math.sign(v) * Math.round(KNEE + (32767 - KNEE) * Math.tanh((a - KNEE) / (32767 - KNEE)))
  }
  return out
}

function mixTick() {
  const now = Date.now()
  const byRoom = new Map<string, Session[]>()
  for (const s of sessions.values()) {
    if (!s.roomId) continue
    const list = byRoom.get(s.roomId) ?? []
    list.push(s)
    byRoom.set(s.roomId, list)
  }
  for (const [roomId, members] of byRoom) {
    const tick = (roomTick.get(roomId) ?? 0) + 1
    roomTick.set(roomId, tick)
    const sources: Array<{ clientId: string; frame: Int16Array }> = []
    for (const s of members) {
      const frame = s.muted ? null : s.stream.pull(now)
      if (frame) sources.push({ clientId: s.clientId, frame })
      updateSpeaking(s, frame ? s.stream.lastRms : 0, now)
    }
    if (sources.length === 0) continue
    for (const listener of members) {
      if (listener.deafened) continue
      const gains = peerGainByListener.get(listener.clientId)
      const mix = new Float32Array(FRAME_SAMPLES)
      let used = 0
      for (const src of sources) {
        if (src.clientId === listener.clientId) continue
        const g = gains?.get(src.clientId) ?? 1
        if (g <= 0) continue
        mixInto(mix, src.frame, g)
        used += 1
      }
      if (used === 0) continue
      const pcm = softClipToPcm(mix)
      if (listener.caps.opus2) sendOpus2(listener, pcm, tick)
      else send(listener, KIND_PCM, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
      listener.stats.txAudioFrames += 1
    }
  }
}

function sendOpus2(listener: Session, pcm: Int16Array, tick: number) {
  let encoded: Buffer
  try {
    encoded = encoderFor(listener).encode(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), FRAME_SAMPLES)
  } catch {
    return
  }
  const continuous = listener.lastTxFrameNo === tick - 1
  if (!continuous) listener.recentEncoded = []
  const frames = [encoded, ...listener.recentEncoded.slice(0, listener.redundancy)]
  send(listener, KIND_OPUS2, encodeOpus2(tick, continuous ? 0 : OPUS2_FLAG_TALKSPURT, frames))
  listener.recentEncoded = [encoded, ...listener.recentEncoded].slice(0, 2)
  listener.lastTxFrameNo = tick
}

function updateSpeaking(s: Session, level: number, now: number) {
  if (level > SPEAKING_RMS) s.lastLoudAtMs = now
  const speaking = now - s.lastLoudAtMs < SPEAKING_HOLD_MS
  if (speaking !== s.speaking) {
    s.speaking = speaking
    hooks.onSpeakingChanged?.({ clientId: s.clientId, speaking })
  }
}

function relayScreenChunks() {
  for (const [roomId, chunks] of screenChunksByRoom) {
    if (chunks.length === 0) continue
    for (const s of sessions.values()) {
      if (s.roomId !== roomId) continue
      for (const entry of chunks) {
        if (entry.clientId === s.clientId || entry.chunk.length > config.screenMaxChunkBytes + 64) continue
        send(s, KIND_SCREEN, entry.chunk)
      }
    }
    screenChunksByRoom.set(roomId, [])
  }
}

/**
 * 20 ms clock without drift. setInterval(20) runs a little late every time (≈20.5 ms in
 * practice), so the mixer consumed ~49 frames/s while clients produce 50: queues grew until
 * frames were thrown away. Here every tick is scheduled against the ideal timeline and missed
 * ticks are caught up (bounded) after a stall.
 */
function startClock() {
  let next = performance.now() + FRAME_MS
  const loop = () => {
    const now = performance.now()
    let ran = 0
    while (now >= next && ran < 5) {
      mixTick()
      relayScreenChunks()
      next += FRAME_MS
      ran += 1
    }
    // Stalled for longer than we can catch up with: restart the timeline.
    if (now - next > 100) next = now + FRAME_MS
    setTimeout(loop, Math.max(0, next - performance.now() - 1))
  }
  setTimeout(loop, FRAME_MS)
}

function startUdp() {
  const socket = dgram.createSocket({ type: "udp4", recvBufferSize: 4 << 20, sendBufferSize: 4 << 20 })
  udpSocket = socket
  socket.on("message", (packet: Buffer, rinfo: RemoteInfo) => {
    if (packet.length < 6) return
    if (packet[0] === 0x48 /* H */ && packet.subarray(0, 5).toString() === "HELLO") {
      const res = acceptHello(packet.toString(), { kind: "udp", remote: { address: rinfo.address, port: rinfo.port } })
      if (res.ok) socket.send(res.ack, rinfo.port, rinfo.address)
      return
    }
    const key = remoteKey(rinfo)
    let session = sessionsByRemote.get(key)
    let decoded = session ? decryptPacket(session.key, packet) : null
    if (session && !decoded) session.stats.rxDecryptDropped += 1
    if (!decoded) {
      // NAT rebinding: the client's source port changed. Find it by key (rare, so a scan is fine).
      for (const s of sessions.values()) {
        if (s.transport !== "udp" || s === session) continue
        const hit = decryptPacket(s.key, packet)
        if (!hit) continue
        if (s.remote) sessionsByRemote.delete(remoteKey(s.remote))
        s.remote = { address: rinfo.address, port: rinfo.port }
        sessionsByRemote.set(key, s)
        session = s
        decoded = hit
        break
      }
    }
    if (!session || !decoded) return
    handlePacket(session, decoded, packet.length)
  })
  socket.on("error", (err) => logger.warn({ err: String(err) }, "media UDP socket error"))
  socket.bind(config.udpPort, config.udpHost, () => {
    let recv = 0
    try {
      recv = socket.getRecvBufferSize()
    } catch {
      /* not supported */
    }
    logger.info({ udpHost: config.udpHost, udpPort: config.udpPort, recvBufferBytes: recv }, "media UDP server listening")
  })
}

const MAX_TCP_FRAME = 64 * 1024

function startTcp() {
  const server = net.createServer((socket: Socket) => {
    // Voice packets are tiny and time-critical; Nagle would hold them back for tens of ms.
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 10_000)
    const label = `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? "?"}`
    const connId = randomUUID()
    let buffer: Buffer = Buffer.alloc(0)
    let session: Session | null = null
    const tcp: NonNullable<Session["tcp"]> = {
      send: (packet) => {
        if (socket.destroyed) return
        const out = Buffer.allocUnsafe(4 + packet.length)
        out.writeUInt32BE(packet.length, 0)
        packet.copy(out, 4)
        socket.write(out)
      },
      backlog: () => socket.writableLength
    }
    socket.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      let off = 0
      while (buffer.length - off >= 4) {
        const n = buffer.readUInt32BE(off)
        if (n <= 0 || n > MAX_TCP_FRAME) {
          logger.warn({ remote: label, bytes: n }, "media tcp invalid frame size; closing")
          socket.destroy()
          return
        }
        if (buffer.length - off < 4 + n) break
        const payload = buffer.subarray(off + 4, off + 4 + n)
        off += 4 + n
        if (payload[0] === 0x48 && payload.subarray(0, 5).toString() === "HELLO") {
          const res = acceptHello(payload.toString(), { kind: "tcp", tcp, label })
          if (!res.ok) {
            tcp.send(Buffer.from("HELLO_FAIL"))
            socket.destroy()
            return
          }
          session = res.session
          tcp.send(res.ack)
          continue
        }
        if (!session) {
          logger.warn({ remote: label, connId }, "media tcp expected HELLO first; closing")
          socket.destroy()
          return
        }
        const decoded = decryptPacket(session.key, payload)
        if (!decoded) {
          session.stats.rxDecryptDropped += 1
          continue
        }
        handlePacket(session, decoded, payload.length)
      }
      buffer = off === buffer.length ? Buffer.alloc(0) : buffer.subarray(off)
    })
    socket.on("error", (err) => logger.debug({ remote: label, err: String(err) }, "media tcp socket error"))
    socket.on("close", () => {
      if (session && session.tcp === tcp) session.tcp = null
    })
  })
  server.listen(config.udpPort, config.udpHost, () => {
    logger.info({ host: config.udpHost, port: config.udpPort }, "media TCP server listening")
  })
}

function startHousekeeping() {
  // Idle sessions inside a room are evicted (the client vanished without leaving).
  setInterval(() => {
    const now = Date.now()
    const idleMs = config.mediaSessionIdleSec * 1000
    for (const [clientId, s] of [...sessions]) {
      if (!s.roomId || now - s.lastPacketAtMs < idleMs) continue
      dropSession(clientId)
      hooks.onSessionStale?.({ clientId })
    }
  }, 15_000).unref()

  setInterval(() => {
    const loopP99 = loopDelay.percentile(99) / 1e6
    const loopMax = loopDelay.max / 1e6
    loopDelay.reset()
    for (const s of sessions.values()) {
      if (!s.roomId && s.stats.rxPackets === 0) continue
      const st = s.stream.stats
      const loss = s.uplinkLoss
      logger.info(
        {
          clientId: s.clientId,
          roomId: s.roomId,
          transport: s.transport,
          remote: s.transport === "udp" ? (s.remote ? remoteKey(s.remote) : null) : (s.tcpLabel ?? "tcp"),
          caps: s.caps,
          ...s.stats,
          uplinkLossPct: Number(uplinkLossPct(s).toFixed(2)),
          uplinkJitterMs: Number(s.stream.jitter.toFixed(1)),
          jitterTargetMs: s.stream.targetFrames * FRAME_MS,
          jitterDepthMs: s.stream.depthFrames * FRAME_MS,
          played: st.played,
          concealed: st.concealed,
          lateDrops: st.lateDrops,
          catchupDrops: st.catchupDrops,
          hardDrops: st.hardDrops,
          underruns: st.underruns,
          downlinkLossPct: s.downlink.lossPermille / 10,
          downlinkJitterMs: s.downlink.jitterMs,
          downlinkBufferMs: s.downlink.bufferMs,
          downlinkBitrate: s.caps.opus2 ? s.downlinkBitrate : null,
          loopDelayP99Ms: Number(loopP99.toFixed(2)),
          loopDelayMaxMs: Number(loopMax.toFixed(2))
        },
        "media network stats snapshot"
      )
      s.stats = freshStats()
      s.uplinkLoss = { expected: 0, received: 0, highest: loss.highest }
      Object.assign(st, { played: 0, concealed: 0, lateDrops: 0, catchupDrops: 0, hardDrops: 0, underruns: 0 })
    }
  }, 5000).unref()
}

export function startMedia(log: MediaLogger, mediaHooks: MediaHooks) {
  logger = log
  hooks = mediaHooks
  startUdp()
  startTcp()
  startClock()
  startHousekeeping()
}

/** For tests: process one tick synchronously. */
export const __test = { mixTick, sessions }
