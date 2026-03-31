const STORAGE_KEY = "voip-peer-volumes-v1"

type RoomVol = { byId: Record<string, number>; byName: Record<string, number> }
type Store = Record<string, Record<string, RoomVol>>

function load(): Store {
  if (typeof window === "undefined") return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Store
  } catch {
    return {}
  }
}

function save(s: Store) {
  if (typeof window === "undefined") return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}

function normName(name: string) {
  return name.trim().toLowerCase()
}

export function getPeerVolume(serverId: string, roomId: string, clientId: string, displayName: string): number {
  const s = load()
  const room = s[serverId]?.[roomId]
  if (!room) return 100
  if (room.byId[clientId] !== undefined) return room.byId[clientId]
  const nk = normName(displayName)
  if (nk && room.byName[nk] !== undefined) {
    const v = room.byName[nk]
    room.byId[clientId] = v
    save(s)
    return v
  }
  return 100
}

export function setPeerVolumeStored(serverId: string, roomId: string, clientId: string, displayName: string, volumePct: number) {
  const pct = Math.max(0, Math.min(200, Math.round(volumePct)))
  const s = load()
  if (!s[serverId]) s[serverId] = {}
  if (!s[serverId][roomId]) s[serverId][roomId] = { byId: {}, byName: {} }
  const room = s[serverId][roomId]
  room.byId[clientId] = pct
  const nk = normName(displayName)
  if (nk) room.byName[nk] = pct
  save(s)
}
