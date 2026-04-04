import net, { type Socket } from "node:net"
import type { FastifyBaseLogger } from "fastify"
import OpusScript from "opusscript"
import { config } from "./config.js"
import { detachTcpTransport, handleTcpPacket, registerTcpHello } from "./media.js"

type MediaHooks = {
  onSpeakingChanged?: (input: { clientId: string; speaking: boolean }) => void
}

const MAX_PACKET_BYTES = 64 * 1024

function framePacket(payload: Buffer): Buffer {
  const out = Buffer.alloc(4 + payload.length)
  out.writeUInt32BE(payload.length, 0)
  payload.copy(out, 4)
  return out
}

type ConnState = {
  buffer: Buffer
  clientId: string | null
  closed: boolean
}

export function createMediaTcpServer(logger: FastifyBaseLogger, hooks: MediaHooks = {}) {
  const server = net.createServer((socket: Socket) => {
    const state: ConnState = {
      buffer: Buffer.alloc(0),
      clientId: null,
      closed: false
    }
    const remoteLabel = `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? "?"}`
    const opusDecoder = new OpusScript(48_000, 1, OpusScript.Application.AUDIO)

    const sendPacket = (packet: Buffer) => {
      if (state.closed || socket.destroyed) return
      socket.write(framePacket(packet))
    }

    socket.on("data", (chunk: Buffer) => {
      if (state.closed) return
      state.buffer = Buffer.concat([state.buffer, chunk])
      while (state.buffer.length >= 4) {
        const n = state.buffer.readUInt32BE(0)
        if (n <= 0 || n > MAX_PACKET_BYTES) {
          logger.warn({ remote: remoteLabel, bytes: n }, "media tcp invalid frame size; closing")
          socket.destroy()
          return
        }
        if (state.buffer.length < 4 + n) break
        const payload = state.buffer.subarray(4, 4 + n)
        state.buffer = state.buffer.subarray(4 + n)

        if (!state.clientId) {
          const text = payload.toString()
          if (!text.startsWith("HELLO ")) {
            logger.warn({ remote: remoteLabel }, "media tcp expected HELLO first; closing")
            socket.destroy()
            return
          }
          const token = text.slice(6).trim()
          const reg = registerTcpHello(logger, { mediaToken: token, sendPacket, remoteLabel })
          if (!reg.ok) {
            socket.write(framePacket(Buffer.from("HELLO_FAIL")))
            socket.destroy()
            return
          }
          state.clientId = reg.clientId
          socket.write(framePacket(Buffer.from("HELLO_ACK")))
          continue
        }

        handleTcpPacket(payload, state.clientId, { logger, hooks, opusDecoder })
      }
    })

    socket.on("error", (err) => {
      logger.debug({ remote: remoteLabel, err: String(err) }, "media tcp socket error")
    })

    socket.on("close", () => {
      state.closed = true
      if (state.clientId) detachTcpTransport(state.clientId)
    })
  })

  server.listen(config.udpPort, config.udpHost, () => {
    logger.info({ host: config.udpHost, port: config.udpPort }, "media TCP server listening")
  })
  return server
}

