export type WsClientEvent =
  | { type: "join_room"; roomId: string }
  | { type: "leave_room" }
  | { type: "set_mute"; muted: boolean }
  | { type: "set_deafen"; deafened: boolean }
  | { type: "set_profile"; displayName: string }
  | { type: "ping"; ts: number }

export type WsServerEvent =
  | { type: "hello"; clientId: string; serverId: string }
  | { type: "rooms_snapshot"; rooms: Array<{ id: string; name: string; kind: "voice" | "text" }> }
  | { type: "rooms_updated"; rooms: Array<{ id: string; name: string; kind: "voice" | "text" }> }
  | {
      type: "roster_snapshot"
      roomId: string | null
      members: Array<{
        clientId: string
        displayName: string
        muted: boolean
        deafened: boolean
        speaking: boolean
      }>
    }
  | {
      type: "member_updated"
      member: { clientId: string; displayName: string; roomId: string | null; muted: boolean; deafened: boolean; speaking: boolean }
    }
  | {
      type: "chat_history_snapshot"
      channelId: string
      messages: Array<{
        id: string
        channelId: string
        author: { clientId: string; displayName: string }
        body: string
        createdAt: string
      }>
      nextCursor: string | null
    }
  | {
      type: "chat_message"
      message: {
        id: string
        channelId: string
        author: { clientId: string; displayName: string }
        body: string
        createdAt: string
      }
    }
  | { type: "pong"; ts: number }
  | { type: "error"; message: string }

export const MEDIA_MAGIC = Buffer.from([0x56, 0x50, 0x01])
