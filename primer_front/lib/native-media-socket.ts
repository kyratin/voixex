import { Capacitor, registerPlugin } from "@capacitor/core"

const NativeMedia = registerPlugin<{
  open(input: { id: string; host: string; port: number; transport: "udp" | "tcp" }): Promise<void>
  send(input: { id: string; data: string }): Promise<void>
  close(input: { id: string }): Promise<void>
  addListener(event: "packet" | "closed", listener: (event: { id: string; data?: string }) => void): Promise<{ remove(): Promise<void> }>
}>("VoixexMedia")

export type MediaSocket = {
  readyState: number
  bufferedAmount: number
  binaryType: string
  onopen: (() => void) | null
  onmessage: ((event: { data: ArrayBuffer }) => void) | null
  onclose: (() => void) | null
  send(data: Uint8Array): void
  close(): void
}

/** Same encrypted media packets as WebSocket; native sockets supply UDP/TCP on Android. */
export class NativeMediaSocket implements MediaSocket {
  readyState = 0
  bufferedAmount = 0
  binaryType = "arraybuffer"
  onopen: (() => void) | null = null
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null
  onclose: (() => void) | null = null
  private id = crypto.randomUUID()
  private listeners: Array<{ remove(): Promise<void> }> = []
  private sending = Promise.resolve()

  static supported() { return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android" }

  constructor(input: { host: string; port: number; transport: "udp" | "tcp" }) {
    void this.open(input)
  }

  private async open(input: { host: string; port: number; transport: "udp" | "tcp" }) {
    try {
      this.listeners.push(await NativeMedia.addListener("packet", event => {
        if (event.id !== this.id || !event.data || this.readyState !== 1) return
        const data = Uint8Array.from(atob(event.data), c => c.charCodeAt(0))
        this.onmessage?.({ data: data.buffer })
      }))
      this.listeners.push(await NativeMedia.addListener("closed", event => { if (event.id === this.id) this.close() }))
      if (this.readyState === 3) { this.removeListeners(); return }
      await NativeMedia.open({ id: this.id, ...input })
      if (this.readyState === 3) { await NativeMedia.close({ id: this.id }); return }
      this.readyState = 1
      this.onopen?.()
    } catch { this.close() }
  }

  send(data: Uint8Array) {
    if (this.readyState !== 1 || this.bufferedAmount > 24 * 1024) return
    const encoded = btoa(String.fromCharCode(...data))
    this.bufferedAmount += data.length
    this.sending = this.sending.then(async () => {
      if (this.readyState === 1) await NativeMedia.send({ id: this.id, data: encoded })
    }).catch(() => this.close()).finally(() => { this.bufferedAmount -= data.length })
  }

  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    void NativeMedia.close({ id: this.id }).catch(() => {})
    this.removeListeners()
    this.onclose?.()
  }
  private removeListeners() {
    for (const listener of this.listeners.splice(0)) void listener.remove().catch(() => {})
  }
}
