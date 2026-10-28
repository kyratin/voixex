import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, Tray } from "electron"
import { join } from "node:path"

/**
 * Tray icon, close-to-tray and the mini call window's placement.
 *
 * The UI owns the call: it sends its state (channel, mute, deafen, translated labels) over
 * "shell:callState", and tray clicks come back to it as "shell:action". The main window tells
 * the UI when it is minimized or hidden ("shell:minimized") so it can open the mini window.
 */

export type ShellAction = "toggle_mute" | "toggle_deafen" | "leave" | "show"

type CallState = {
  inVoice: boolean
  channel: string
  muted: boolean
  deafened: boolean
  labels: {
    open: string
    mute: string
    unmute: string
    deafen: string
    undeafen: string
    leave: string
    quit: string
    notInVoice: string
  }
}

const DEFAULT_LABELS: CallState["labels"] = {
  open: "Open Voixex",
  mute: "Mute",
  unmute: "Unmute",
  deafen: "Deafen",
  undeafen: "Undeafen",
  leave: "Leave voice channel",
  quit: "Quit Voixex",
  notInVoice: "Not in a voice channel"
}

export function createShell(options: { iconsDir: () => string }) {
  let mainWindow: BrowserWindow | null = null
  let tray: Tray | null = null
  let quitting = false
  let closeToTray = true
  let state: CallState = { inVoice: false, channel: "", muted: false, deafened: false, labels: DEFAULT_LABELS }

  app.on("before-quit", () => {
    quitting = true
  })

  const send = (channel: string, payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }

  const showMain = () => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  const reportMinimized = () => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    send("shell:minimized", !win.isVisible() || win.isMinimized())
  }

  const trayIcon = () => {
    const dir = options.iconsDir()
    if (process.platform === "darwin") {
      // A template image follows the light/dark menu bar.
      const icon = nativeImage.createFromPath(join(dir, "trayTemplate.png"))
      icon.setTemplateImage(true)
      return icon
    }
    return nativeImage.createFromPath(join(dir, "tray.png"))
  }

  const rebuildTray = () => {
    if (!tray) return
    const l = state.labels
    const items: Electron.MenuItemConstructorOptions[] = [{ label: l.open, click: showMain }, { type: "separator" }]
    if (state.inVoice) {
      items.push(
        { label: `🔊 ${state.channel}`, enabled: false },
        { label: state.muted ? l.unmute : l.mute, click: () => send("shell:action", "toggle_mute") },
        { label: state.deafened ? l.undeafen : l.deafen, click: () => send("shell:action", "toggle_deafen") },
        { label: l.leave, click: () => send("shell:action", "leave") }
      )
    } else {
      items.push({ label: l.notInVoice, enabled: false })
    }
    items.push({ type: "separator" }, { label: l.quit, click: () => app.quit() })
    tray.setContextMenu(Menu.buildFromTemplate(items))
    const status = state.inVoice ? `${state.channel}${state.muted ? " · 🔇" : ""}${state.deafened ? " · 🎧✕" : ""}` : ""
    tray.setToolTip(status ? `Voixex — ${status}` : "Voixex")
  }

  ipcMain.on("shell:callState", (_event, next: Partial<CallState>) => {
    state = { ...state, ...next, labels: { ...DEFAULT_LABELS, ...(next.labels ?? {}) } }
    rebuildTray()
  })
  ipcMain.on("shell:showMain", () => showMain())
  ipcMain.on("shell:setPreferences", (_event, prefs: { closeToTray?: boolean }) => {
    if (typeof prefs?.closeToTray === "boolean") closeToTray = prefs.closeToTray
  })
  ipcMain.handle("shell:isMinimized", () => {
    const win = mainWindow
    return Boolean(win && !win.isDestroyed() && (!win.isVisible() || win.isMinimized()))
  })

  return {
    showMain,

    attachMainWindow(win: BrowserWindow) {
      mainWindow = win
      for (const event of ["minimize", "restore", "hide", "show", "focus"] as const) {
        win.on(event as "minimize", reportMinimized)
      }
      win.on("close", (event) => {
        // The tray keeps the call going; "Quit" in the tray (or Cmd+Q) really exits.
        if (quitting || !closeToTray || !tray) return
        event.preventDefault()
        win.hide()
      })
      win.on("closed", () => {
        if (mainWindow === win) mainWindow = null
      })
    },

    createTray() {
      if (tray) return
      tray = new Tray(trayIcon())
      rebuildTray()
      // Windows/Linux: a left click opens the app, the menu is on the right click.
      if (process.platform !== "darwin") tray.on("click", showMain)
    },

    /** Bottom-right corner of the screen the main window is on, shown without taking focus. */
    placeMiniWindow(child: BrowserWindow, parent: BrowserWindow) {
      const display = screen.getDisplayMatching(parent.getBounds())
      const area = display.workArea
      const [w, h] = child.getSize()
      child.setPosition(area.x + area.width - w - 16, area.y + area.height - h - 16)
      child.setAlwaysOnTop(true, "floating")
      child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      child.once("ready-to-show", () => child.showInactive())
      // about:blank may already be ready.
      setTimeout(() => {
        if (!child.isDestroyed() && !child.isVisible()) child.showInactive()
      }, 150)
    }
  }
}
