const { contextBridge, ipcRenderer } = require("electron")

const electronVoice = {
  requestMicrophoneAccess: () => ipcRenderer.invoke("voice:requestMicrophoneAccess"),
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
  sendScreenChunk: (chunkBase64) => ipcRenderer.invoke("voice:sendScreenChunk", chunkBase64),
  listScreenSources: () => ipcRenderer.invoke("screenShare:listSources"),
  setScreenSource: (sourceId) => ipcRenderer.invoke("screenShare:setSource", sourceId),
  onPcm16Frame: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on("voice:pcm16Frame", handler)
    return () => ipcRenderer.removeListener("voice:pcm16Frame", handler)
  },
  onScreenChunk: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on("voice:screenChunk", handler)
    return () => ipcRenderer.removeListener("voice:screenChunk", handler)
  },
  onHotkeyAction: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on("voice:hotkeyAction", handler)
    return () => ipcRenderer.removeListener("voice:hotkeyAction", handler)
  }
}

/** Per-server device certificates; private keys stay in the main process. */
const voixexIdentity = {
  create: () => ipcRenderer.invoke("identity:create"),
  setCertificate: (ref, certificate) => ipcRenderer.invoke("identity:setCertificate", ref, certificate),
  get: (ref) => ipcRenderer.invoke("identity:get", ref),
  sign: (ref, message) => ipcRenderer.invoke("identity:sign", ref, message),
  remove: (ref) => ipcRenderer.invoke("identity:remove", ref),
  list: () => ipcRenderer.invoke("identity:list"),
  setMeta: (ref, meta) => ipcRenderer.invoke("identity:setMeta", ref, meta),
  exportToFile: (ref, passphrase, server) => ipcRenderer.invoke("identity:export", ref, passphrase, server),
  pickImportFile: () => ipcRenderer.invoke("identity:pickImportFile"),
  importFromFile: (contents, passphrase) => ipcRenderer.invoke("identity:import", contents, passphrase)
}

contextBridge.exposeInMainWorld("electronVoice", electronVoice)
/** Lets the UI draw its own title bar where the system one is hidden (Windows/Linux). */
contextBridge.exposeInMainWorld("voixexWindow", { platform: process.platform, customTitleBar: true })
contextBridge.exposeInMainWorld("voixexIdentity", voixexIdentity)
