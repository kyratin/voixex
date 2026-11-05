# Cameras (0.7.0)

Android, macOS and Windows share camera capture, local preview, participant tiles and device selection. Camera starts only after an explicit click, is independent of microphone mute, and stops on leaving/changing the voice room, app backgrounding, device removal and component teardown. The last device is remembered; enabled state is not persisted.

## Transports

- UDP, TCP and WebSocket use encrypted media kind **6**, negotiated as `camera1` in HELLO2/HELLO_ACK. The server forwards packets between these transports and stamps the authenticated sender. Camera packets are restricted to the sender's current room and server, with an independent camera policy and a 256 KiB/s sender budget.
- Legacy camera v1 uses independent JPEG frames, up to 480 pixels wide, JPEG quality 0.55, at most 8 fps (encoding and pacing lower the actual rate). Fragments have a 24-byte header plus at most 900 bytes. Frames over 96 KiB are skipped. There is no retransmission: the next complete image recovers after loss. Receiver assembly expires at 500 ms, retains at most two frames per sender and 128 incomplete frames total, and rejects stale completed frames.
- LiveKit publishes a separate camera video track, requesting 720p/30 capture and simulcast. Camera does not replace screen share or acquire another microphone.
- When LiveKit is available, the publisher also sends the compatibility JPEG stream. This lets clients on different transports see one another without server transcoding. Receivers prefer the LiveKit track and fall back to the JPEG image. **This costs additional upload bandwidth**; the compatibility path is lower quality than WebRTC. A codec bridge and selective subscriptions are future optimizations.

Android's native `VoixexMedia` plugin supplies UDP and length-prefixed TCP sockets to the existing encrypted WebVoiceEngine. WebSocket remains an explicit choice. Desktop supports all three transports in VoiceEngine. WebRTC camera uses the shared LiveKit client on all platforms. Android camera permission is requested through Capacitor's WebChromeClient.

## Server update

Client and server must both be 0.7.0+ for cameras. `/v1/servers/:serverId/rooms/:roomId/camera` reports capabilities and policy; old servers leave the camera unavailable. `allowCamera` is independent of `allowMic` and `allowStreams`, defaults to true on new servers and can be changed in channel rules. The server must be updated before installing the client if camera support is needed.

The server branch contains the matching camera protocol and relay. `voice-client/src/camera-protocol.ts` and `backend/src/media/camera-protocol.ts` must be identical; the transport integration check enforces this. Existing audio packet layouts are unchanged.

## Checks

```sh
npm run build --prefix voice-client
npm test --prefix voice-client
(cd primer_front && npx tsc --noEmit && npm run build)
# Server checkout: compile backend first.
CAMERA_CLIENT_ROOT=/absolute/client node /absolute/server/backend/test/camera-transports.mjs
# Local LiveKit test on ws://127.0.0.1:17880, devkey/camera-test-secret-local-only:
CAMERA_SERVER_ROOT=/absolute/server node primer_front/scripts/camera-browser-check.mjs
```

The browser test uses fake camera input but real Chromium encoding, LiveKit transport and decoded video. It checks camera + screen, stop/disconnect, permission failure and capture resolving after a room change. Camera validation CI runs these checks; release CI builds Android, macOS and Windows. Compilation and synthetic media checks do not replace testing physical cameras, Android devices or OS permission dialogs.
