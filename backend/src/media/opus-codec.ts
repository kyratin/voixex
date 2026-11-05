import { createRequire } from "node:module"

// opusscript's JS/C++ bridge represents PCM bytes as uint16 slots. Its stock wrapper
// treats malloc byte addresses as uint16 indexes and underallocates decode scratch
// (especially 120 ms PLC), corrupting other codecs when participants join/leave.
type Handler = { _encode(input: number, bytes: number, output: number, samples: number): number; _decode(input: number, bytes: number, output: number): number; _encoder_ctl(request: number, value: number): number; _decoder_ctl(request: number, value: number): number }
type Module = { HEAPU8: Uint8Array; _malloc(bytes: number): number; _free(pointer: number): void; OpusScriptHandler: { new(rate: number, channels: number, application: number): Handler; destroy_handler(handler: Handler): void } }
const require = createRequire(import.meta.url)
const wasm = (require("opusscript/build/opusscript_native_wasm.js") as () => Module)()
const MAX_PACKET_BYTES = 1276 * 3
const MAX_DECODE_SAMPLES = 960 * 6

/** Own correctly sized scratch, use byte offsets, and refresh views after WASM growth. */
export class OpusCodec {
  static readonly Application = { VOIP: 2048, AUDIO: 2049, RESTRICTED_LOWDELAY: 2051 }
  private readonly handler: Handler
  private readonly pointers: number[] = []
  private readonly inputPcm: number
  private readonly inputOpus: number
  private readonly outputOpus: number
  private readonly outputPcm: number
  private deleted = false
  private previous: Buffer | null = null

  constructor(private readonly rate: number, private readonly channels: number, application: number) {
    if (![8000, 12000, 16000, 24000, 48000].includes(rate) || (channels !== 1 && channels !== 2)) throw new RangeError("Invalid Opus format")
    this.handler = new wasm.OpusScriptHandler(rate, channels, application)
    const pcmBytes = MAX_DECODE_SAMPLES * channels * 2
    const allocate = (bytes: number) => { const p = wasm._malloc(bytes); if (!p) throw new Error("Opus scratch allocation failed"); this.pointers.push(p); return p }
    try {
      // _encode expands source bytes to uint16, then reads two slots per PCM byte.
      this.inputPcm = allocate(pcmBytes * 4)
      this.inputOpus = allocate(MAX_PACKET_BYTES)
      this.outputOpus = allocate(MAX_PACKET_BYTES)
      // _decode writes two uint16 byte slots per int16 output sample.
      this.outputPcm = allocate(pcmBytes * 2)
    } catch (error) { this.delete(); throw error }
  }

  private check() { if (this.deleted) throw new Error("Opus codec is closed") }

  encode(pcm: Buffer, frameSize: number): Buffer {
    this.check()
    if (![2.5, 5, 10, 20, 40, 60].some(ms => frameSize === this.rate * ms / 1000) || pcm.length !== frameSize * this.channels * 2) throw new RangeError("Invalid Opus PCM frame")
    const input = new Uint16Array(wasm.HEAPU8.buffer, this.inputPcm, pcm.length * 2)
    input.fill(0); input.set(pcm)
    const size = this.handler._encode(this.inputPcm, pcm.length, this.outputOpus, frameSize)
    if (size < 0 || size > MAX_PACKET_BYTES) throw new Error(`Opus encode failed (${size})`)
    return Buffer.from(new Uint8Array(wasm.HEAPU8.buffer, this.outputOpus, size))
  }

  decode(packet: Buffer): Buffer {
    this.check()
    if (packet.length > MAX_PACKET_BYTES) throw new RangeError("Opus packet exceeds limit")
    // The binding requests 120 ms for native PLC, while the mixer consumes 20 ms.
    // A bounded repeat lets the jitter buffer apply its fade without advancing Opus by 120 ms.
    if (!packet.length) return this.previous ? Buffer.from(this.previous.subarray(0, this.rate / 50 * this.channels * 2)) : Buffer.alloc(this.rate / 50 * this.channels * 2)
    new Uint8Array(wasm.HEAPU8.buffer, this.inputOpus, packet.length).set(packet)
    const samples = this.handler._decode(this.inputOpus, packet.length, this.outputPcm)
    if (samples < 0 || samples > MAX_DECODE_SAMPLES) throw new Error(`Opus decode failed (${samples})`)
    const pcm = Buffer.from(new Uint16Array(wasm.HEAPU8.buffer, this.outputPcm, samples * this.channels * 2))
    this.previous = pcm
    return pcm
  }

  encoderCTL(request: number, value: number) { this.check(); const result = this.handler._encoder_ctl(request, value); if (result < 0) throw new Error(`Opus encoder control failed (${result})`) }
  decoderCTL(request: number, value: number) { this.check(); const result = this.handler._decoder_ctl(request, value); if (result < 0) throw new Error(`Opus decoder control failed (${result})`) }
  setBitrate(value: number) { this.encoderCTL(4002, value) }
  delete() {
    if (this.deleted) return
    this.deleted = true
    try { wasm.OpusScriptHandler.destroy_handler(this.handler) } finally { for (const p of this.pointers) wasm._free(p); this.previous = null }
  }
}
