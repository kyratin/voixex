import { app, BrowserWindow, ipcMain } from "electron"
import { existsSync } from "node:fs"
import { release } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { VoiceService } from "./voice-service.js"

const voice = new VoiceService()
const __dirname = fileURLToPath(new URL(".", import.meta.url))
const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000"
const bundledUiPath = join(__dirname, "../ui/index.html")

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

function loadFallbackErrorPage(win: BrowserWindow, error: string, target: string) {
  const html = `<!doctype html><html><body style="font-family:sans-serif;padding:24px;background:#111;color:#eee">
  <h2>Kyratin VoIP: UI load failed</h2>
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
      nodeIntegration: false
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
  voice.setOnIncomingPcm16((pcm16Base64) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("voice:pcm16Frame", pcm16Base64)
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
  ipcMain.handle("voice:sendPcm16Frame", (_event, pcm16Base64: string) => {
    voice.sendPcm16Frame(pcm16Base64)
    return { ok: true }
  })

  createWindow()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
