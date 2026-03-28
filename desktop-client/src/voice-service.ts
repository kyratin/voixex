import { VoiceEngine, type AudioDeviceSelection } from "voip-voice-client"

type VoiceState = {
  connected: boolean
  joinedRoomId: string | null
  muted: boolean
  deafened: boolean
  selfTestTone: boolean
}

export class VoiceService {
  private engine: VoiceEngine | null = null
  private onIncomingPcm16: ((pcm16Base64: string) => void) | null = null
  private onIncomingScreenChunk: ((chunkBase64: string) => void) | null = null
  private state: VoiceState = {
    connected: false,
    joinedRoomId: null,
    muted: false,
    deafened: false,
    selfTestTone: false
  }

  connect(input: { host: string; port: number; mediaToken: string }) {
    const payload = decodeTokenPayload(input.mediaToken)
    const mediaSeed = String(payload.mediaSeed ?? "")
    if (!mediaSeed) {
      throw new Error("mediaToken has no mediaSeed")
    }
    this.engine?.close()
    this.engine = new VoiceEngine({
      host: input.host,
      port: input.port,
      mediaToken: input.mediaToken,
      mediaSeed
    })
    this.engine.setOnPcm16Frame((frame) => {
      this.onIncomingPcm16?.(frame.toString("base64"))
    })
    this.engine.setOnScreenChunk((chunk) => {
      this.onIncomingScreenChunk?.(chunk.toString("base64"))
    })
    this.engine.connect()
    this.state.connected = true
    this.state.joinedRoomId = null
    this.state.muted = false
    this.state.deafened = false
    this.state.selfTestTone = false
    return this.state
  }

  joinRoom(roomId: string) {
    this.engine?.joinRoom(roomId)
    this.state.joinedRoomId = roomId
    return this.state
  }

  leaveRoom() {
    this.engine?.leaveRoom()
    this.state.joinedRoomId = null
    return this.state
  }

  setMute(muted: boolean) {
    this.engine?.setMute(muted)
    this.state.muted = muted
    return this.state
  }

  setDeafen(deafened: boolean) {
    this.engine?.setDeafen(deafened)
    this.state.deafened = deafened
    return this.state
  }

  disconnect() {
    this.engine?.close()
    this.engine = null
    this.state = {
      connected: false,
      joinedRoomId: null,
      muted: false,
      deafened: false,
      selfTestTone: false
    }
    return this.state
  }

  getState() {
    return this.state
  }

  setSelfTestTone(enabled: boolean) {
    if (!this.engine) return this.state
    if (enabled) {
      this.engine.startSelfTestTone()
    } else {
      this.engine.stopSelfTestTone()
    }
    this.state.selfTestTone = enabled
    return this.state
  }

  getStats() {
    if (!this.engine) {
      return { ...this.state, txPackets: 0, rxPackets: 0 }
    }
    return { ...this.state, ...this.engine.getStats() }
  }

  listAudioDevices() {
    if (!this.engine) {
      return [
        { id: "default-input", label: "Default Input", kind: "input", isDefault: true },
        { id: "default-output", label: "Default Output", kind: "output", isDefault: true }
      ]
    }
    return this.engine.listAudioDevices()
  }

  getAudioDevices() {
    if (!this.engine) {
      return { inputId: null, outputId: null }
    }
    return this.engine.getAudioDevices()
  }

  setAudioDevices(selection: AudioDeviceSelection) {
    if (!this.engine) {
      return { inputId: selection.inputId, outputId: selection.outputId }
    }
    return this.engine.setAudioDevices(selection)
  }

  sendPcm16Frame(pcm16Base64: string) {
    if (!this.engine) return
    this.engine.sendPcm16Frame(Buffer.from(pcm16Base64, "base64"))
  }

  sendScreenChunk(chunkBase64: string) {
    if (!this.engine) return
    this.engine.sendScreenChunk(Buffer.from(chunkBase64, "base64"))
  }

  setOnIncomingPcm16(listener: ((pcm16Base64: string) => void) | null) {
    this.onIncomingPcm16 = listener
  }

  setOnIncomingScreenChunk(listener: ((chunkBase64: string) => void) | null) {
    this.onIncomingScreenChunk = listener
  }
}

function decodeTokenPayload(token: string): Record<string, unknown> {
  const parts = token.split(".")
  if (parts.length !== 3) return {}
  const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
  const pad = payloadB64.length % 4
  const withPad = pad ? payloadB64 + "=".repeat(4 - pad) : payloadB64
  return JSON.parse(Buffer.from(withPad, "base64").toString("utf8")) as Record<string, unknown>
}
