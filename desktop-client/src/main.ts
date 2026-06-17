import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, session, systemPreferences } from "electron"
import { existsSync } from "node:fs"
import { release } from "node:os"
import { join, normalize, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { VoiceService } from "./voice-service.js"

const voice = new VoiceService()
let preferredScreenSourceId: string | null = null
const __dirname = fileURLToPath(new URL(".", import.meta.url))
const BUNDLED_UI_SCHEME = "app"
const BUNDLED_UI_HOST = "bundle"

function normalizeFrontendUrl(raw: string | undefined): string {
  const trimmed = (raw ?? "http://localhost:3000").trim()
  if (!trimmed) return "http://localhost:3000"
  // Misconfigured env on Windows (e.g. FRONTEND_URL=K:) becomes file:///K:/ and breaks load.
  if (/^[a-zA-Z]:\\?$/.test(trimmed) || /^file:\/\/[a-zA-Z]:\/?$/i.test(trimmed)) {
    return "http://localhost:3000"
  }
  return trimmed
}

const frontendUrl = normalizeFrontendUrl(process.env.FRONTEND_URL)
const bundledUiRoot = join(__dirname, "../ui")
const bundledUiPath = join(bundledUiRoot, "index.html")

protocol.registerSchemesAsPrivileged([
  {
    scheme: BUNDLED_UI_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
])

function getBundledUiEntryUrl(): string | null {
  if (!existsSync(bundledUiPath)) return null
  return `${BUNDLED_UI_SCHEME}://${BUNDLED_UI_HOST}/index.html`
}

function resolveBundledUiRequestPath(uiRoot: string, pathname: string): string | null {
  let p = decodeURIComponent(pathname)
  if (p === "/" || p === "") p = "/index.html"
  else if (p.endsWith("/")) p += "index.html"

  const segments = p.split("/").filter(Boolean)
  const filePath = normalize(join(uiRoot, ...segments))
  const rel = relative(normalize(uiRoot), filePath)
  if (rel.startsWith("..")) return null
  if (existsSync(filePath)) return filePath

  const fallback = join(uiRoot, "index.html")
  return existsSync(fallback) ? fallback : null
}

async function registerBundledUiProtocol(): Promise<void> {
  if (!existsSync(bundledUiPath)) return
  await protocol.handle(BUNDLED_UI_SCHEME, (request) => {
    try {
      const url = new URL(request.url)
      if (url.host !== BUNDLED_UI_HOST) return new Response("Not found", { status: 404 })
      const filePath = resolveBundledUiRequestPath(bundledUiRoot, url.pathname)
      if (!filePath) return new Response("Not found", { status: 404 })
      return net.fetch(pathToFileURL(filePath).href)
    } catch (err) {
      console.error("bundled UI protocol error", err)
      return new Response("Internal error", { status: 500 })
    }
  })
}

function resolveRuntimeIconPath(): string | undefined {
  const iconsDir = app.isPackaged ? process.resourcesPath : join(__dirname, "../build/icons")
  const candidates =
    process.platform === "win32"
      ? ["icon.ico"]
      : process.platform === "darwin"
        ? ["icon.icns", "icon-512.png"]
        : ["icon-512.png", "icon.png"]
  for (const name of candidates) {
    const iconPath = join(iconsDir, name)
    if (existsSync(iconPath)) return iconPath
  }
  return undefined
}
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

// Self-hosted API often uses HTTPS with a private/self-signed cert. Without this, fetch/wss fail with "Failed to fetch".
app.on("certificate-error", (event, _webContents, _url, _error, _certificate, callback) => {
  event.preventDefault()
  callback(true)
})

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
  const iconPath = resolveRuntimeIconPath()
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#111111",
    show: false,
    icon: iconPath ? nativeImage.createFromPath(iconPath) : undefined,
    webPreferences: {
      preload: join(__dirname, "../preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win.once("ready-to-show", () => win.show())
  const bundledEntry = getBundledUiEntryUrl()
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame) return
    loadFallbackErrorPage(
      win,
      `did-fail-load: ${errorCode} ${errorDescription} (${validatedUrl})`,
      bundledEntry ?? frontendUrl
    )
  })
  win.webContents.on("render-process-gone", (_event, details) => {
    loadFallbackErrorPage(win, `render-process-gone: ${details.reason}`, bundledEntry ?? bundledUiPath)
  })
  if (bundledEntry) {
    void win.loadURL(bundledEntry)
  } else {
    void win.loadURL(frontendUrl)
  }
}

app.whenReady().then(async () => {
  await registerBundledUiProtocol()
  if (process.platform === "win32") {
    app.setAppUserModelId("com.voixex.desktop")
    // Keep Windows title bar clean like on macOS build.
    Menu.setApplicationMenu(null)
  }
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"] })
      const preferred =
        (preferredScreenSourceId && sources.find((s) => s.id === preferredScreenSourceId)) || sources[0]
      if (!preferred) {
        callback({})
        return
      }
      if (request.audioRequested) {
        callback({
          video: preferred,
          audio: process.platform === "darwin" || process.platform === "win32" ? "loopback" : undefined
        })
      } else {
        callback({ video: preferred })
      }
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

  ipcMain.handle("voice:connect", (_event, payload: { host: string; port: number; mediaToken: string; transport?: "udp" | "tcp" }) => {
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
  // High-frequency media packets should not use invoke/handle RPC.
  // send/on avoids per-packet Promise churn and lowers renderer/main CPU.
  ipcMain.on("voice:sendPcm16Frame", (_event, pcm16Base64: string) => {
    voice.sendPcm16Frame(pcm16Base64)
  })
  ipcMain.on("voice:sendOpusFrame", (_event, opusBase64: string) => {
    voice.sendOpusFrame(opusBase64)
  })
  ipcMain.on("voice:sendScreenChunk", (_event, chunkBase64: string) => {
    voice.sendScreenChunk(chunkBase64)
  })
  // Backward compatibility for any callers still using invoke/handle.
  ipcMain.handle("voice:sendPcm16Frame", (_event, pcm16Base64: string) => {
    voice.sendPcm16Frame(pcm16Base64)
    return { ok: true }
  })
  ipcMain.handle("voice:sendOpusFrame", (_event, opusBase64: string) => {
    voice.sendOpusFrame(opusBase64)
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
