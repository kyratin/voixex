import { Worker } from "node:worker_threads"
import type { FastifyBaseLogger } from "fastify"
import type { HostToWorker, WorkerToHost } from "./media/worker.js"

type MediaHooks = {
  onSpeakingChanged?: (input: { clientId: string; speaking: boolean }) => void
  onSessionStale?: (input: { clientId: string }) => void
}

/**
 * Main-thread handle for the voice media worker (UDP/TCP voice, jitter buffers, mixer).
 * Keeps the same functions the HTTP/WS side always called; state is mirrored here so a worker
 * that crashes is restarted with every member's room, flags and volumes.
 */

const roomByClient = new Map<string, string | null>()
const flagsByClient = new Map<string, { muted: boolean; deafened: boolean }>()
const volumes = new Map<string, Map<string, number>>()

let worker: Worker | null = null

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
    w.on("message", (m: WorkerToHost) => {
      if (m.t === "log") logger[m.level](m.obj, m.msg)
      else if (m.t === "speaking") hooks.onSpeakingChanged?.({ clientId: m.clientId, speaking: m.speaking })
      else if (m.t === "stale") hooks.onSessionStale?.({ clientId: m.clientId })
    })
    w.on("error", (err) => logger.error({ err: String(err) }, "media worker crashed"))
    w.on("exit", (code) => {
      if (worker !== w) return
      worker = null
      logger.warn({ code }, "media worker exited; restarting")
      setTimeout(start, 1000).unref()
    })
    for (const [clientId, roomId] of roomByClient) w.postMessage({ t: "room", clientId, roomId } satisfies HostToWorker)
    for (const [clientId, f] of flagsByClient) w.postMessage({ t: "flags", clientId, ...f } satisfies HostToWorker)
    for (const [listener, m] of volumes) {
      for (const [target, pct] of m) w.postMessage({ t: "volume", listener, target, pct } satisfies HostToWorker)
    }
  }
  start()
}
