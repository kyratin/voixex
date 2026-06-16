#!/usr/bin/env node
/**
 * Minimal WS presence smoke test: join → connect WS → expect presence_snapshot → ping → sync_presence.
 *
 * Usage:
 *   node presence-ws-smoke.mjs --api https://kyratin.ru --password SECRET --display-name tester
 */

import { randomUUID } from "node:crypto"

function parseArgs(argv) {
  const out = { api: "http://localhost:18080", password: "", displayName: "presence-smoke" }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--api") out.api = argv[++i] ?? out.api
    else if (a === "--password") out.password = argv[++i] ?? ""
    else if (a === "--display-name") out.displayName = argv[++i] ?? out.displayName
  }
  if (!out.password) throw new Error("--password is required")
  return out
}

async function main() {
  const { api, password, displayName } = parseArgs(process.argv)
  const clientId = randomUUID()
  const joinRes = await fetch(`${api.replace(/\/+$/, "")}/v1/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, clientId, displayName })
  })
  if (!joinRes.ok) throw new Error(`join failed: ${joinRes.status}`)
  const join = await joinRes.json()
  const token = join.authToken
  if (!token) throw new Error("no authToken in join response")

  const wsUrl = `${api.replace(/^http/, "ws")}/v1/ws?token=${encodeURIComponent(token)}`
  const ws = new WebSocket(wsUrl)
  const messages = []

  ws.addEventListener("message", (ev) => {
    try {
      messages.push(JSON.parse(String(ev.data)))
    } catch {
      /* ignore */
    }
  })

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve)
    ws.addEventListener("error", reject)
    setTimeout(() => reject(new Error("ws open timeout")), 10_000)
  })

  await new Promise((r) => setTimeout(r, 500))

  const hello = messages.find((m) => m.type === "hello")
  const presence = messages.find((m) => m.type === "presence_snapshot")
  if (!hello) throw new Error("missing hello")
  if (!presence) throw new Error("missing presence_snapshot")
  console.log("OK hello serverGeneration=", hello.serverGeneration)
  console.log("OK presence_snapshot rooms=", Object.keys(presence.rosters ?? {}).length, "lobby=", (presence.lobby ?? []).length)

  ws.send(JSON.stringify({ type: "ping", ts: Date.now() }))
  await new Promise((r) => setTimeout(r, 300))
  const pong = messages.find((m) => m.type === "pong")
  if (!pong) throw new Error("missing pong after ping")
  console.log("OK pong")

  const roomsRes = await fetch(`${api.replace(/\/+$/, "")}/v1/servers/${join.serverId}/rooms`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const roomsBody = await roomsRes.json()
  const voiceRoom = (roomsBody.rooms ?? []).find((r) => r.kind === "voice")
  if (!voiceRoom) throw new Error("no voice room")

  const before = messages.length
  ws.send(
    JSON.stringify({
      type: "sync_presence",
      roomId: voiceRoom.id,
      muted: true,
      deafened: false,
      screenSharing: false,
      watchingScreen: false
    })
  )
  await new Promise((r) => setTimeout(r, 500))
  const after = messages.slice(before)
  const memberUpdated = after.find((m) => m.type === "member_updated")
  const roster = after.find((m) => m.type === "roster_snapshot" && m.roomId === voiceRoom.id)
  if (!memberUpdated?.member?.muted) throw new Error("sync_presence did not set muted")
  if (!roster) throw new Error("missing roster_snapshot after sync_presence")
  console.log("OK sync_presence muted member in room", voiceRoom.name)

  ws.close()
  console.log("All presence smoke checks passed.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
