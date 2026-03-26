const { contextBridge, ipcRenderer } = require("electron")

const electronVoice = {
  connect: (payload) => ipcRenderer.invoke("voice:connect", payload),
  joinRoom: (roomId) => ipcRenderer.invoke("voice:joinRoom", roomId),
  leaveRoom: () => ipcRenderer.invoke("voice:leaveRoom"),
  setMute: (muted) => ipcRenderer.invoke("voice:setMute", muted),
  setDeafen: (deafened) => ipcRenderer.invoke("voice:setDeafen", deafened),
  disconnect: () => ipcRenderer.invoke("voice:disconnect"),
  getState: () => ipcRenderer.invoke("voice:getState"),
  setSelfTestTone: (enabled) => ipcRenderer.invoke("voice:setSelfTestTone", enabled),
  getStats: () => ipcRenderer.invoke("voice:getStats"),
  listAudioDevices: () => ipcRenderer.invoke("voice:listAudioDevices"),
  getAudioDevices: () => ipcRenderer.invoke("voice:getAudioDevices"),
  setAudioDevices: (selection) => ipcRenderer.invoke("voice:setAudioDevices", selection),
  getKeybinds: () => ipcRenderer.invoke("voice:getKeybinds"),
  setKeybinds: (keybinds) => ipcRenderer.invoke("voice:setKeybinds", keybinds),
  clearKeybinds: () => ipcRenderer.invoke("voice:clearKeybinds"),
  sendPcm16Frame: (pcm16Base64) => ipcRenderer.invoke("voice:sendPcm16Frame", pcm16Base64),
  onPcm16Frame: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on("voice:pcm16Frame", handler)
    return () => ipcRenderer.removeListener("voice:pcm16Frame", handler)
  },
  onHotkeyAction: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on("voice:hotkeyAction", handler)
    return () => ipcRenderer.removeListener("voice:hotkeyAction", handler)
  }
}

contextBridge.exposeInMainWorld("electronVoice", electronVoice)
