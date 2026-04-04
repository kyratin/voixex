import { contextBridge, ipcRenderer } from "electron"

const electronVoice = {
  requestMicrophoneAccess: () => ipcRenderer.invoke("voice:requestMicrophoneAccess"),
  connect: (payload: { host: string; port: number; mediaToken: string; transport?: "udp" | "tcp" }) =>
    ipcRenderer.invoke("voice:connect", payload),
  joinRoom: (roomId: string) => ipcRenderer.invoke("voice:joinRoom", roomId),
  leaveRoom: () => ipcRenderer.invoke("voice:leaveRoom"),
  setMute: (muted: boolean) => ipcRenderer.invoke("voice:setMute", muted),
  setDeafen: (deafened: boolean) => ipcRenderer.invoke("voice:setDeafen", deafened),
  disconnect: () => ipcRenderer.invoke("voice:disconnect"),
  getState: () => ipcRenderer.invoke("voice:getState"),
  setSelfTestTone: (enabled: boolean) => ipcRenderer.invoke("voice:setSelfTestTone", enabled),
  getStats: () => ipcRenderer.invoke("voice:getStats"),
  listAudioDevices: () => ipcRenderer.invoke("voice:listAudioDevices"),
  getAudioDevices: () => ipcRenderer.invoke("voice:getAudioDevices"),
  setAudioDevices: (selection: { inputId: string | null; outputId: string | null }) => ipcRenderer.invoke("voice:setAudioDevices", selection),
  getKeybinds: () => ipcRenderer.invoke("voice:getKeybinds"),
  setKeybinds: (keybinds: { toggleMute: string | null; toggleDeafen: string | null; pushToTalk: string | null }) =>
    ipcRenderer.invoke("voice:setKeybinds", keybinds),
  clearKeybinds: () => ipcRenderer.invoke("voice:clearKeybinds"),
  sendPcm16Frame: (pcm16Base64: string) => ipcRenderer.send("voice:sendPcm16Frame", pcm16Base64),
  sendOpusFrame: (opusBase64: string) => ipcRenderer.send("voice:sendOpusFrame", opusBase64),
  sendScreenChunk: (chunkBase64: string) => ipcRenderer.send("voice:sendScreenChunk", chunkBase64),
  listScreenSources: () => ipcRenderer.invoke("screenShare:listSources"),
  setScreenSource: (sourceId: string | null) => ipcRenderer.invoke("screenShare:setSource", sourceId),
  onPcm16Frame: (listener: (pcm16Base64: string) => void) => {
    const handler = (_event: unknown, payload: string) => listener(payload)
    ipcRenderer.on("voice:pcm16Frame", handler)
    return () => ipcRenderer.removeListener("voice:pcm16Frame", handler)
  },
  onScreenChunk: (listener: (chunkBase64: string) => void) => {
    const handler = (_event: unknown, payload: string) => listener(payload)
    ipcRenderer.on("voice:screenChunk", handler)
    return () => ipcRenderer.removeListener("voice:screenChunk", handler)
  },
  onHotkeyAction: (listener: (payload: { action: "toggle_mute" | "toggle_deafen" | "push_to_talk" }) => void) => {
    const handler = (_event: unknown, payload: { action: "toggle_mute" | "toggle_deafen" | "push_to_talk" }) => listener(payload)
    ipcRenderer.on("voice:hotkeyAction", handler)
    return () => ipcRenderer.removeListener("voice:hotkeyAction", handler)
  }
}

contextBridge.exposeInMainWorld("electronVoice", electronVoice)
