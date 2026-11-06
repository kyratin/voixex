import { parentPort } from "node:worker_threads"
import {
  removeMember,
  setMemberCameraAllowed,
  setMemberFlags,
  setMemberRoom,
  setMemberSpeaking,
  setPeerVolume,
  startMedia,
  wsClose,
  wsData,
  wsOpen,
  type MediaLogger
} from "./core.js"

/**
 * Voice media runs in its own thread: the main thread parses multi-megabyte WebSocket screen
 * chunks, runs SQLite queries and serves HTTP, and every such pause used to delay the 20 ms
 * mixer tick for everyone in voice.
 */

export type HostToWorker =
  | { t: "camera"; clientId: string; allowed: boolean }
  | { t: "room"; clientId: string; roomId: string | null }
  | { t: "flags"; clientId: string; muted: boolean; deafened: boolean }
  | { t: "speaking"; clientId: string; speaking: boolean }
  | { t: "volume"; listener: string; target: string; pct: number }
  | { t: "remove"; clientId: string }
  /** Media over WebSocket: the socket is on the main thread, packets are relayed. */
  | { t: "wsopen"; connId: string; label: string }
  | { t: "wsdata"; connId: string; data: Uint8Array; at:number }
  | { t: "wssent"; connId: string; bytes:number; buffered:number;kind?:number }
  | { t: "wsclose"; connId: string }

export type WorkerToHost =
  | { t: "log"; level: "info" | "warn" | "debug"; obj: object; msg?: string }
  | { t: "speaking"; clientId: string; speaking: boolean }
  | { t: "stale"; clientId: string }
  | { t: "levels"; roomId: string; levels: Record<string, number> }
  | { t: "wssend"; connId: string; data: Uint8Array;kind:number;at:number }
  | { t: "wsprocessed"; connId:string;bytes:number }
  | { t: "wsend"; connId: string }

const port = parentPort
if (!port) throw new Error("media worker must run in a worker thread")
const post = (m: WorkerToHost) => port.postMessage(m)

const log: MediaLogger = {
  info: (obj, msg) => post({ t: "log", level: "info", obj, msg }),
  warn: (obj, msg) => post({ t: "log", level: "warn", obj, msg }),
  debug: (obj, msg) => post({ t: "log", level: "debug", obj, msg })
}

const outbound=new Map<string,{pending:number;buffered:number;audio:number;video:number}>()
let outboundTotal=0
port.on("message", (m: HostToWorker) => {
  switch (m.t) {
    case "camera":
      return setMemberCameraAllowed(m.clientId, m.allowed)
    case "room":
      return setMemberRoom(m.clientId, m.roomId)
    case "flags":
      return setMemberFlags(m.clientId, m.muted, m.deafened)
    case "speaking":
      return setMemberSpeaking(m.clientId, m.speaking)
    case "volume":
      return setPeerVolume(m.listener, m.target, m.pct)
    case "remove":
      return removeMember(m.clientId)
    case "wsopen":
      outbound.set(m.connId,{pending:0,buffered:0,audio:0,video:0})
      return wsOpen(
        m.connId,
        m.label,
        (packet,meta) => {
          const state=outbound.get(m.connId)
          if(!state)return
          state.pending+=packet.length;outboundTotal+=packet.length
          if(meta?.kind===6)state.video+=packet.length
          else if(meta&&[0,2,3,7].includes(meta.kind))state.audio++
          post({ t: "wssend", connId: m.connId, data: packet,kind:meta?.kind??-1,at:meta?.at??Date.now() })
        },
        () => post({ t: "wsend", connId: m.connId }),
        (kind) => {const state=outbound.get(m.connId);if(outboundTotal>8*1024*1024||!state)return 1024*1024;return state.buffered+(kind===6?state.video/4:kind!==undefined&&[0,2,3,7].includes(kind)?state.audio*1600:state.pending)}
      )
    case "wsdata":
      try { wsData(m.connId, Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength),m.at) }
      finally {post({t:"wsprocessed",connId:m.connId,bytes:m.data.length})}
      return
    case "wssent": {
      outboundTotal=Math.max(0,outboundTotal-m.bytes)
      const state=outbound.get(m.connId)
      if(state){state.pending=Math.max(0,state.pending-m.bytes);state.buffered=m.buffered;if(m.kind===6)state.video=Math.max(0,state.video-m.bytes);else if(m.bytes&&m.kind!==undefined&&[0,2,3,7].includes(m.kind))state.audio=Math.max(0,state.audio-1)}
      return
    }
    case "wsclose":
      outbound.delete(m.connId)
      return wsClose(m.connId)
  }
})

startMedia(log, {
  onSpeakingChanged: ({ clientId, speaking }) => post({ t: "speaking", clientId, speaking }),
  onSessionStale: ({ clientId }) => post({ t: "stale", clientId }),
  onVoiceLevels: ({ roomId, levels }) => post({ t: "levels", roomId, levels })
})
