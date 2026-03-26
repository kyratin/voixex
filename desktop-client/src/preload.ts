import { contextBridge, ipcRenderer } from "electron"

const electronVoice = {
  connect: (payload: { host: string; port: number; mediaToken: string }) => ipcRenderer.invoke("voice:connect", payload),
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
  sendPcm16Frame: (pcm16Base64: string) => ipcRenderer.invoke("voice:sendPcm16Frame", pcm16Base64),
  onPcm16Frame: (listener: (pcm16Base64: string) => void) => {
    const handler = (_event: unknown, payload: string) => listener(payload)
    ipcRenderer.on("voice:pcm16Frame", handler)
    return () => ipcRenderer.removeListener("voice:pcm16Frame", handler)
  }
}

contextBridge.exposeInMainWorld("electronVoice", electronVoice)
