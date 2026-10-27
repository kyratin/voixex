import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, session, systemPreferences } from "electron"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { release } from "node:os"
import { join, normalize, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { IdentityStore, type IdentityMeta, type IdentityServerInfo, type ServerCertificate } from "./identity-store.js"
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

/** Height of the title bar the UI draws (must match TITLE_BAR_HEIGHT in the frontend). */
const TITLE_BAR_HEIGHT = 32
// macOS: hidden title bar with the traffic lights centred in the UI's bar (the UI leaves room on the left).
// Windows/Linux: hidden title bar with the native window buttons overlaid on the right.
const customTitleBar =
  process.platform === "darwin"
    ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 12, y: 9 } }
    : {
        titleBarStyle: "hidden" as const,
        titleBarOverlay: { color: "#0f0f14", symbolColor: "#9494a1", height: TITLE_BAR_HEIGHT }
      }

function createWindow() {
  const iconPath = resolveRuntimeIconPath()
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0f0f14",
    // Drop the light system title bar; the UI draws a dark one under the native window controls.
    ...customTitleBar,
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
  win.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: {
      width: 1280,
      height: 760,
      backgroundColor: "#0f0f14",
      autoHideMenuBar: true,
      ...customTitleBar,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    }
  }))
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
  const identities = new IdentityStore(join(app.getPath("userData"), "identities.json"))
  ipcMain.handle("identity:create", () => identities.create())
  ipcMain.handle("identity:setCertificate", (_event, ref: string, certificate: ServerCertificate) =>
    identities.setCertificate(ref, certificate)
  )
  ipcMain.handle("identity:get", (_event, ref: string) => identities.get(ref))
  ipcMain.handle("identity:sign", (_event, ref: string, message: string) => identities.sign(ref, message))
  ipcMain.handle("identity:remove", (_event, ref: string) => identities.remove(ref))
  ipcMain.handle("identity:list", () => identities.list())
  ipcMain.handle("identity:setMeta", (_event, ref: string, meta: IdentityMeta) => identities.setMeta(ref, meta ?? {}))
  ipcMain.handle("identity:export", async (event, ref: string, passphrase: string, server: IdentityServerInfo) => {
    const contents = identities.exportEncrypted(ref, passphrase, server)
    const win = BrowserWindow.fromWebContents(event.sender)
    const safeLabel = (server.label || "server").replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 40)
    const options = {
      title: "Export certificate",
      defaultPath: `${safeLabel}.voixexkey`,
      filters: [{ name: "Voixex certificate", extensions: ["voixexkey"] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, contents, { mode: 0o600 })
    return result.filePath
  })
  /** Step 1 of import: pick the file (the passphrase is asked for afterwards in the UI). */
  ipcMain.handle("identity:pickImportFile", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: "Import certificate",
      properties: ["openFile" as const],
      filters: [{ name: "Voixex certificate", extensions: ["voixexkey"] }]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return { path: result.filePaths[0], contents: readFileSync(result.filePaths[0], "utf8") }
  })
  ipcMain.handle("identity:import", (_event, contents: string, passphrase: string) =>
    identities.importEncrypted(contents, passphrase)
  )
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
