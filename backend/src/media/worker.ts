import { parentPort } from "node:worker_threads"
import {
  removeMember,
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
  | { t: "room"; clientId: string; roomId: string | null }
  | { t: "flags"; clientId: string; muted: boolean; deafened: boolean }
  | { t: "speaking"; clientId: string; speaking: boolean }
  | { t: "volume"; listener: string; target: string; pct: number }
  | { t: "remove"; clientId: string }
  /** Media over WebSocket: the socket is on the main thread, packets are relayed. */
  | { t: "wsopen"; connId: string; label: string }
  | { t: "wsdata"; connId: string; data: Uint8Array }
  | { t: "wsclose"; connId: string }

export type WorkerToHost =
  | { t: "log"; level: "info" | "warn" | "debug"; obj: object; msg?: string }
  | { t: "speaking"; clientId: string; speaking: boolean }
  | { t: "stale"; clientId: string }
  | { t: "levels"; roomId: string; levels: Record<string, number> }
  | { t: "wssend"; connId: string; data: Uint8Array }
  | { t: "wsend"; connId: string }

const port = parentPort
if (!port) throw new Error("media worker must run in a worker thread")
const post = (m: WorkerToHost) => port.postMessage(m)

const log: MediaLogger = {
  info: (obj, msg) => post({ t: "log", level: "info", obj, msg }),
  warn: (obj, msg) => post({ t: "log", level: "warn", obj, msg }),
  debug: (obj, msg) => post({ t: "log", level: "debug", obj, msg })
}

port.on("message", (m: HostToWorker) => {
  switch (m.t) {
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
      return wsOpen(
        m.connId,
        m.label,
        (packet) => post({ t: "wssend", connId: m.connId, data: packet }),
        () => post({ t: "wsend", connId: m.connId })
      )
    case "wsdata":
      return wsData(m.connId, Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength))
    case "wsclose":
      return wsClose(m.connId)
  }
})

startMedia(log, {
  onSpeakingChanged: ({ clientId, speaking }) => post({ t: "speaking", clientId, speaking }),
  onSessionStale: ({ clientId }) => post({ t: "stale", clientId }),
  onVoiceLevels: ({ roomId, levels }) => post({ t: "levels", roomId, levels })
})
