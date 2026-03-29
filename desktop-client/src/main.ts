import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, session, systemPreferences } from "electron"
import { existsSync } from "node:fs"
import { release } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { VoiceService } from "./voice-service.js"

const voice = new VoiceService()
let preferredScreenSourceId: string | null = null
const __dirname = fileURLToPath(new URL(".", import.meta.url))
const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000"
const bundledUiPath = join(__dirname, "../ui/index.html")
type HotkeyAction = "toggle_mute" | "toggle_deafen" | "push_to_talk"
type KeybindConfig = { toggleMute: string | null; toggleDeafen: string | null; pushToTalk: string | null }
let keybinds: KeybindConfig = {
  toggleMute: "CommandOrControl+Shift+M",
  toggleDeafen: "CommandOrControl+Shift+D",
  pushToTalk: "CommandOrControl+Shift+V"
}

function emitHotkeyAction(action: HotkeyAction) {
  const payload = { action }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("voice:hotkeyAction", payload)
  }
}

function registerHotkeys() {
  globalShortcut.unregisterAll()
  const mappings: Array<{ accelerator: string | null; action: HotkeyAction }> = [
    { accelerator: keybinds.toggleMute, action: "toggle_mute" },
    { accelerator: keybinds.toggleDeafen, action: "toggle_deafen" },
    { accelerator: keybinds.pushToTalk, action: "push_to_talk" }
  ]
  for (const item of mappings) {
    if (!item.accelerator) continue
    const ok = globalShortcut.register(item.accelerator, () => emitHotkeyAction(item.action))
    if (!ok) {
      console.warn(`Failed to register hotkey: ${item.accelerator}`)
    }
  }
}

function isLegacyWindows10() {
  if (process.platform !== "win32") return false
  const parts = release().split(".")
  const build = Number(parts[2] ?? "0")
  return Number.isFinite(build) && build > 0 && build < 22000
}

if (isLegacyWindows10()) {
  // Win10 GPU stack can cause blank white window in Electron.
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch("in-process-gpu")
  app.commandLine.appendSwitch("disable-gpu-compositing")
}
app.commandLine.appendSwitch("disable-renderer-backgrounding")

function loadFallbackErrorPage(win: BrowserWindow, error: string, target: string) {
  const html = `<!doctype html><html><body style="font-family:sans-serif;padding:24px;background:#111;color:#eee">
  <h2>Voixex: UI load failed</h2>
  <p>Cannot open frontend source:</p><pre>${target}</pre>
  <p>Error:</p><pre>${error}</pre>
  <p>Tip: for packaged app, ensure bundled UI exists. For dev mode, set FRONTEND_URL.</p>
  </body></html>`
  void win.loadURL(`data:text/html,${encodeURIComponent(html)}`)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#111111",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win.once("ready-to-show", () => win.show())
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    loadFallbackErrorPage(win, `did-fail-load: ${errorCode} ${errorDescription} (${validatedUrl})`, validatedUrl || frontendUrl)
  })
  win.webContents.on("render-process-gone", (_event, details) => {
    loadFallbackErrorPage(win, `render-process-gone: ${details.reason}`, existsSync(bundledUiPath) ? bundledUiPath : frontendUrl)
  })
  if (existsSync(bundledUiPath)) {
    void win.loadFile(bundledUiPath)
  } else {
    void win.loadURL(frontendUrl)
  }
}

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"] })
      const preferred =
        (preferredScreenSourceId && sources.find((s) => s.id === preferredScreenSourceId)) || sources[0]
      callback({ video: preferred })
    },
    { useSystemPicker: true }
  )
  registerHotkeys()
  voice.setOnIncomingPcm16((pcm16Base64) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("voice:pcm16Frame", pcm16Base64)
    }
  })
  voice.setOnIncomingScreenChunk((chunkBase64) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("voice:screenChunk", chunkBase64)
    }
  })
  ipcMain.handle("voice:requestMicrophoneAccess", async () => {
    if (process.platform !== "darwin") {
      return { granted: true as const }
    }
    try {
      const granted = await systemPreferences.askForMediaAccess("microphone")
      return { granted }
    } catch {
      return { granted: false as const }
    }
  })

  ipcMain.handle("voice:connect", (_event, payload: { host: string; port: number; mediaToken: string }) => {
    return voice.connect(payload)
  })
  ipcMain.handle("voice:joinRoom", (_event, roomId: string) => {
    return voice.joinRoom(roomId)
  })
  ipcMain.handle("voice:leaveRoom", () => {
    return voice.leaveRoom()
  })
  ipcMain.handle("voice:setMute", (_event, muted: boolean) => {
    return voice.setMute(muted)
  })
  ipcMain.handle("voice:setDeafen", (_event, deafened: boolean) => {
    return voice.setDeafen(deafened)
  })
  ipcMain.handle("voice:disconnect", () => {
    return voice.disconnect()
  })
  ipcMain.handle("voice:getState", () => {
    return voice.getState()
  })
  ipcMain.handle("voice:setSelfTestTone", (_event, enabled: boolean) => {
    return voice.setSelfTestTone(enabled)
  })
  ipcMain.handle("voice:getStats", () => {
    return voice.getStats()
  })
  ipcMain.handle("voice:listAudioDevices", () => {
    return voice.listAudioDevices()
  })
  ipcMain.handle("voice:getAudioDevices", () => {
    return voice.getAudioDevices()
  })
  ipcMain.handle("voice:setAudioDevices", (_event, selection: { inputId: string | null; outputId: string | null }) => {
    return voice.setAudioDevices(selection)
  })
  ipcMain.handle("voice:getKeybinds", () => {
    return { ...keybinds }
  })
  ipcMain.handle("voice:setKeybinds", (_event, next: KeybindConfig) => {
    keybinds = {
      toggleMute: next.toggleMute?.trim() || null,
      toggleDeafen: next.toggleDeafen?.trim() || null,
      pushToTalk: next.pushToTalk?.trim() || null
    }
    registerHotkeys()
    return { ...keybinds }
  })
  ipcMain.handle("voice:clearKeybinds", () => {
    keybinds = { toggleMute: null, toggleDeafen: null, pushToTalk: null }
    registerHotkeys()
    return { ...keybinds }
  })
  ipcMain.handle("voice:sendPcm16Frame", (_event, pcm16Base64: string) => {
    voice.sendPcm16Frame(pcm16Base64)
    return { ok: true }
  })
  ipcMain.handle("voice:sendScreenChunk", (_event, chunkBase64: string) => {
    voice.sendScreenChunk(chunkBase64)
    return { ok: true }
  })
  ipcMain.handle("screenShare:listSources", async () => {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } })
    return sources.map((s) => ({ id: s.id, name: s.name }))
  })
  ipcMain.handle("screenShare:setSource", (_event, sourceId: string | null) => {
    preferredScreenSourceId = sourceId
    return { ok: true }
  })

  createWindow()
})

app.on("window-all-closed", () => {
  globalShortcut.unregisterAll()
  if (process.platform !== "darwin") app.quit()
})
