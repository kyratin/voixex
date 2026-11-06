// The worklet runs at the helper's fixed 48 kHz. Queue bounds prevent stale
// audio replay after the renderer stalls; underruns produce silence.
export const windowsScreenAudioWorklet = `
class WindowsScreenAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(4800);
    this.right = new Float32Array(4800);
    this.read = 0; this.length = 0;
    this.port.onmessage = ({data}) => {
      if (!(data instanceof Float32Array) || data.length % 2) return;
      const frames = data.length / 2;
      // Keep at most 100ms after an overrun instead of playing a growing backlog.
      if (this.length + frames > 4800) { this.read = 0; this.length = 0; }
      const start = Math.max(0, frames - 4800);
      for (let i = start; i < frames; i++) {
        const at = (this.read + this.length) % this.left.length;
        this.left[at] = Number.isFinite(data[i * 2]) ? data[i * 2] : 0;
        this.right[at] = Number.isFinite(data[i * 2 + 1]) ? data[i * 2 + 1] : 0;
        this.length++;
      }
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    for (let i = 0; i < output[0].length; i++) {
      const available = this.length > 0;
      output[0][i] = available ? this.left[this.read] : 0;
      output[1][i] = available ? this.right[this.read] : 0;
      if (available) { this.read = (this.read + 1) % this.left.length; this.length--; }
    }
    return true;
  }
}
registerProcessor('windows-screen-audio', WindowsScreenAudioProcessor);
`

/** Attach isolated native PCM to the same stream published by LiveKit/MediaRecorder. */
export async function attachWindowsScreenAudio(stream: MediaStream): Promise<void> {
  const bridge = window.electronVoice
  if (!bridge?.startScreenAudio || !bridge.stopScreenAudio || !bridge.onScreenAudio || !bridge.onScreenAudioEnded)
    throw new Error("Native Windows audio bridge unavailable")
  const id = crypto.randomUUID()
  const context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" })
  const destination = context.createMediaStreamDestination()
  const track = destination.stream.getAudioTracks()[0]
  let node: AudioWorkletNode | undefined
  let closed = false
  let removePcm = () => {}
  let removeEnded = () => {}
  const video = stream.getVideoTracks()[0]
  const originalStop = track.stop.bind(track)
  const cleanup = () => {
    if (closed) return
    closed = true
    removePcm()
    removeEnded()
    video?.removeEventListener("ended", cleanup)
    node?.disconnect()
    node?.port.close()
    originalStop()
    void context.close().catch(() => {})
    void bridge.stopScreenAudio!(id).catch(() => {})
  }
  // MediaStreamTrack.stop() does not dispatch 'ended'; callers stop tracks directly.
  track.stop = cleanup
  video?.addEventListener("ended", cleanup, { once: true })
  const url = URL.createObjectURL(new Blob([windowsScreenAudioWorklet], { type: "text/javascript" }))
  try {
    await context.audioWorklet.addModule(url)
    if (context.sampleRate !== 48000) throw new Error("Native audio requires a 48 kHz AudioContext")
    node = new AudioWorkletNode(context, "windows-screen-audio", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
    node.connect(destination)
    removePcm = bridge.onScreenAudio(({ id: captureId, pcm }) => {
      if (captureId !== id || closed || !pcm.byteLength || pcm.byteLength % 8) return
      const bytes = new Uint8Array(pcm).slice()
      const samples = new Float32Array(bytes.buffer)
      node!.port.postMessage(samples, [samples.buffer])
    })
    removeEnded = bridge.onScreenAudioEnded(({ id: captureId }) => {
      if (captureId !== id) return
      cleanup()
      stream.removeTrack(track)
      track.dispatchEvent(new Event("ended"))
    })
    await context.resume()
    if (context.state !== "running") throw new Error("Native audio context did not start")
    if (closed || video?.readyState !== "live") throw new Error("Screen capture ended")
    await bridge.startScreenAudio(id)
    if (closed || video?.readyState !== "live") throw new Error("Screen capture ended")
    stream.addTrack(track)
  } catch (error) {
    cleanup()
    throw error
  } finally {
    URL.revokeObjectURL(url)
  }
}
