import { Worker } from "node:worker_threads"
import type { FastifyBaseLogger } from "fastify"
import type { HostToWorker, WorkerToHost } from "./media/worker.js"

type MediaHooks = {
  onSpeakingChanged?: (input: { clientId: string; speaking: boolean }) => void
  onSessionStale?: (input: { clientId: string }) => void
  onVoiceLevels?: (input: { roomId: string; levels: Record<string, number> }) => void
}

/**
 * Main-thread handle for the voice media worker (UDP/TCP voice, jitter buffers, mixer).
 * Keeps the same functions the HTTP/WS side always called; state is mirrored here so a worker
 * that crashes is restarted with every member's room, flags and volumes.
 */

const cameraAllowed = new Map<string, boolean>()
export function setMemberCameraAllowed(clientId: string, allowed: boolean) {
  cameraAllowed.set(clientId, allowed)
  post({ t: "camera", clientId, allowed })
}

const roomByClient = new Map<string, string | null>()
const flagsByClient = new Map<string, { muted: boolean; deafened: boolean }>()
const volumes = new Map<string, Map<string, number>>()

let worker: Worker | null = null

/** WebSocket media connections relayed to the worker. */
type MediaSocket = { send: (data: Uint8Array) => void; close: () => void; bufferedAmount: () => number }
type SocketState={socket:MediaSocket;pendingBytes:number;pendingMessages:number;reportedBuffer:number}
const mediaSockets = new Map<string, SocketState>()
let ingressBytes=0
/** Above this much unsent data (≈0.5 s of audio) packets are skipped instead of adding delay. */
const WS_MAX_BACKLOG_BYTES = 4 * 1024

function post(m: HostToWorker) {
  worker?.postMessage(m)
}

export function setMemberRoom(clientId: string, roomId: string | null) {
  roomByClient.set(clientId, roomId)
  post({ t: "room", clientId, roomId })
}

export function setMemberFlags(clientId: string, muted: boolean, deafened: boolean) {
  flagsByClient.set(clientId, { muted, deafened })
  post({ t: "flags", clientId, muted, deafened })
}

export function setMemberSpeaking(clientId: string, speaking: boolean) {
  post({ t: "speaking", clientId, speaking })
}

export function setPeerVolume(listener: string, target: string, pct: number) {
  const m = volumes.get(listener) ?? new Map<string, number>()
  m.set(target, pct)
  volumes.set(listener, m)
  post({ t: "volume", listener, target, pct })
}

export function removeMember(clientId: string) {
  cameraAllowed.delete(clientId)
  roomByClient.delete(clientId)
  flagsByClient.delete(clientId)
  volumes.delete(clientId)
  for (const m of volumes.values()) m.delete(clientId)
  post({ t: "remove", clientId })
}

function workerUrl() {
  // Running from TypeScript sources (tsx dev): start the .ts worker through tsx as well.
  const fromTs = import.meta.url.endsWith(".ts")
  return {
    url: new URL(fromTs ? "./media/worker.ts" : "./media/worker.js", import.meta.url),
    execArgv: fromTs ? ["--import", "tsx"] : []
  }
}

/** Starts the media worker (UDP and TCP on the configured media port). */
export function createMediaServer(logger: FastifyBaseLogger, hooks: MediaHooks = {}) {
  const start = () => {
    const { url, execArgv } = workerUrl()
    const w = new Worker(url, { execArgv })
    worker = w
    ingressBytes=0
    w.on("message", (m: WorkerToHost) => {
      if(worker!==w)return
      if (m.t === "log") logger[m.level](m.obj, m.msg)
      else if (m.t === "speaking") hooks.onSpeakingChanged?.({ clientId: m.clientId, speaking: m.speaking })
      else if (m.t === "stale") hooks.onSessionStale?.({ clientId: m.clientId })
      else if (m.t === "levels") hooks.onVoiceLevels?.({ roomId: m.roomId, levels: m.levels })
      else if(m.t==="wsprocessed"){
        ingressBytes=Math.max(0,ingressBytes-m.bytes)
        const state=mediaSockets.get(m.connId)
        if(state){state.pendingBytes=Math.max(0,state.pendingBytes-m.bytes);state.pendingMessages=Math.max(0,state.pendingMessages-1)}
      } else if (m.t === "wssend") {
        const state=mediaSockets.get(m.connId),sock=state?.socket
        const control=m.kind===-1||m.kind===5||m.kind===8
        try {
          if(sock&&Date.now()-m.at<=(control?250:80)&&(control||sock.bufferedAmount()<(m.kind===6?2048:WS_MAX_BACKLOG_BYTES)))sock.send(m.data)
        }catch {
          // A disconnected reader must not take down HTTP and all other media sockets.
          sock?.close()
        }finally{
          const buffered=sock?.bufferedAmount()??0
          if(state)state.reportedBuffer=buffered
          post({t:"wssent",connId:m.connId,bytes:m.data.length,buffered,kind:m.kind})
        }
      } else if (m.t === "wsend") mediaSockets.get(m.connId)?.socket.close()
    })
    w.on("error", (err) => logger.error({ err: String(err) }, "media worker crashed"))
    w.on("exit", (code) => {
      if (worker !== w) return
      worker = null
      logger.warn({ code }, "media worker exited; restarting")
      setTimeout(start, 1000).unref()
    })
    // Media sockets belonged to the old worker's sessions; clients reconnect.
    for (const state of mediaSockets.values()) state.socket.close()
    for (const [clientId, allowed] of cameraAllowed) w.postMessage({ t: "camera", clientId, allowed } satisfies HostToWorker)
    for (const [clientId, roomId] of roomByClient) w.postMessage({ t: "room", clientId, roomId } satisfies HostToWorker)
    for (const [clientId, f] of flagsByClient) w.postMessage({ t: "flags", clientId, ...f } satisfies HostToWorker)
    for (const [listener, m] of volumes) {
      for (const [target, pct] of m) w.postMessage({ t: "volume", listener, target, pct } satisfies HostToWorker)
    }
  }
  start()
}

/** Registers a media WebSocket (binary frames, one encrypted packet or HELLO per frame). */
export function attachMediaSocket(connId: string, label: string, socket: MediaSocket) {
  const state:SocketState={socket,pendingBytes:0,pendingMessages:0,reportedBuffer:0}
  mediaSockets.set(connId,state)
  post({ t: "wsopen", connId, label })
  return {
    data(frame: Uint8Array) {
      if(!worker||state.pendingMessages>=32||state.pendingBytes+frame.length>48*1024||ingressBytes+frame.length>4*1024*1024)return
      state.pendingMessages++;state.pendingBytes+=frame.length;ingressBytes+=frame.length
      post({ t: "wsdata", connId, data: frame,at:Date.now() })
    },
    closed() {
      mediaSockets.delete(connId)
      post({ t: "wsclose", connId })
    }
  }
}

// Recover promptly when a reliable socket drains, even if no ordinary packet was sent.
setInterval(()=>{
  for(const [connId,state] of mediaSockets)if(state.reportedBuffer>0){
    const buffered=state.socket.bufferedAmount()
    if(buffered!==state.reportedBuffer){state.reportedBuffer=buffered;post({t:"wssent",connId,bytes:0,buffered})}
  }
},40).unref()
