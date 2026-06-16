# Presence sync — manual acceptance checklist

Run against a server built with realtime presence sync (session registry, heartbeat, `presence_snapshot`, `sync_presence`).

## Prerequisites

- Two clients (A and B), same voice server
- Optional: `wscat` for raw WS inspection (`npm i -g wscat`)

## Scenarios

| # | Steps | Expected |
|---|--------|----------|
| 1 | A and B join the same voice channel; A toggles mute | B sees mute icon within ~1s |
| 2 | A kills network (no WS close); wait 45–60s | A evicted from roster; no ghost in channel |
| 3 | A reconnects WS while still in voice (desktop transport up) | Full `presence_snapshot`; A mute/deafen preserved via `sync_presence` |
| 4 | A switches voice channel A→B | Both channel rosters correct; A only in B |
| 5 | A starts screen share, then leaves voice | `screen_sharing` cleared; sharer icon gone for B |
| 6 | Restart server container | Clients reconnect; rosters repopulate; no stale ghosts after TTL |
| 7 | WebRTC mode (staging + LiveKit) | Sidebar mute/screen matches LiveKit state |

## WS smoke test

1. Join server via UI; copy auth token from devtools / join response.
2. Connect: `wscat -c "wss://HOST/v1/ws?token=TOKEN"`
3. On connect you should receive `hello` (with `serverGeneration`), `rooms_snapshot`, `presence_snapshot`.
4. Send heartbeat: `{"type":"ping","ts":1234567890}` → `pong`.
5. Send sync: `{"type":"sync_presence","roomId":"ROOM_ID","muted":true,"deafened":false,"screenSharing":false,"watchingScreen":false}` → `member_updated` + `roster_snapshot` for room and lobby.

## Automated helper

```bash
node primer_front/scripts/presence-ws-smoke.mjs --api https://kyratin.ru --password SERVER_PASSWORD --display-name smoke-test
```
