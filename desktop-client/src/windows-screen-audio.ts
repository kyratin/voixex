import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { WebContents } from "electron"

/** One capture per renderer. Ownership and capture IDs prevent stale stops/frames. */
export class WindowsScreenAudio {
  private captures = new Map<number, { id: string; stop: () => void }>()
  constructor(private executable: string) {}

  stop(owner: WebContents, id?: string) {
    const capture = this.captures.get(owner.id)
    if (capture && (!id || capture.id === id)) capture.stop()
  }

  stopAll() {
    for (const capture of this.captures.values()) capture.stop()
  }

  async start(owner: WebContents, id: string): Promise<void> {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("Invalid audio capture ID")
    this.stop(owner)
    await new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams
      try {
        // The native API excludes the main process AND every Electron child,
        // including the audio service. Renderer PID alone would not exclude calls.
        child = spawn(this.executable, [String(process.pid)], { windowsHide: true, stdio: "pipe" })
      } catch (error) { reject(error); return }
      let ready = false
      let ended = false
      let status = ""
      let pending = Buffer.alloc(0)
      const send = (channel: string, payload: unknown) => {
        if (!owner.isDestroyed()) owner.send(channel, payload)
      }
      const finish = (error: Error) => {
        if (ended) return
        ended = true
        clearTimeout(timeout)
        owner.removeListener("destroyed", onDestroyed)
        owner.removeListener("did-start-navigation", onNavigation)
        if (this.captures.get(owner.id)?.id === id) this.captures.delete(owner.id)
        child.kill()
        pending = Buffer.alloc(0)
        if (!ready) reject(error)
        else send("screenAudio:ended", { id, error: error.message })
      }
      const onDestroyed = () => finish(new Error("Capture window closed"))
      const onNavigation = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
        if (isMainFrame && !isInPlace) finish(new Error("Capture window navigated"))
      }
      const timeout = setTimeout(() => finish(new Error("Native screen audio startup timed out")), 10000)
      owner.once("destroyed", onDestroyed)
      owner.on("did-start-navigation", onNavigation)
      this.captures.set(owner.id, { id, stop: () => finish(new Error("Capture stopped")) })
      child.on("error", error => finish(error))
      child.on("close", code => finish(new Error(`Native screen audio exited (${code}): ${status.slice(-512)}`)))
      child.stderr.on("data", (data: Buffer) => {
        status = (status + data.toString("utf8")).slice(-4096)
        if (!ended && !ready && status.split(/\r?\n/).includes("READY 48000 2 f32")) {
          ready = true
          clearTimeout(timeout)
          resolve()
        }
      })
      child.stdout.on("data", (data: Buffer) => {
        if (ended) return
        pending = Buffer.concat([pending, data])
        // Pipe reads can split float samples. Forward complete 20 ms stereo blocks.
        const bytes = 960 * 2 * 4
        while (pending.length >= bytes) {
          send("screenAudio:pcm", { id, pcm: new Uint8Array(pending.subarray(0, bytes)) })
          pending = pending.subarray(bytes)
        }
      })
    })
  }
}
