import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'

const compiled = await build({ entryPoints: [new URL('../lib/windows-screen-audio.ts', import.meta.url).pathname], bundle: true, write: false, format: 'cjs', platform: 'node' })
const module = { exports: {} }
const globals = { module, exports: module.exports }
vm.runInNewContext(compiled.outputFiles[0].text, globals)
let Processor
vm.runInNewContext(module.exports.windowsScreenAudioWorklet, {
  AudioWorkletProcessor: class { port = {} }, Float32Array, Number, Math,
  registerProcessor: (_name, type) => { Processor = type }
})
const processor = new Processor()
const render = () => {
  const output = [new Float32Array(128), new Float32Array(128)]
  assert.equal(processor.process([], [output]), true)
  return output
}
const feed = samples => processor.port.onmessage({ data: samples })
assert.ok(render()[0].every(value => value === 0), 'underrun is silence')
feed(new Float32Array([0.5, -0.25, NaN, Infinity]))
let output = render()
assert.equal(output[0][0], 0.5)
assert.equal(output[1][0], -0.25)
assert.equal(output[0][1], 0)
assert.equal(output[1][1], 0)
assert.ok(output[0].slice(2).every(value => value === 0))
for (let i = 0; i < 100; i++) feed(new Float32Array(1920).fill(0.1))
assert.ok(processor.length <= 4800, 'backlog remains bounded')
feed(new Float32Array(48000).fill(0.75))
assert.equal(processor.length, 4800)
assert.ok(render()[0].every(value => value === 0.75), 'old backlog is discarded')
feed(new Float32Array(3))
assert.ok(processor.length <= 4800, 'malformed stereo frame ignored')
console.log('PASS Windows PCM worklet: stereo, silence, invalid samples, bounded backlog and recovery')

let pcmListener, endedListener, stopped = [], contexts = [], nodes = [], fail = false
class Track extends EventTarget {
  readyState = 'live'
  stop() { this.readyState = 'ended' }
}
const bridge = {
  startScreenAudio: async () => { if (fail) throw new Error('activation failure') },
  stopScreenAudio: async id => { stopped.push(id) },
  onScreenAudio: listener => { pcmListener = listener; return () => { pcmListener = undefined } },
  onScreenAudioEnded: listener => { endedListener = listener; return () => { endedListener = undefined } }
}
Object.assign(globals, {
  window: { electronVoice: bridge }, crypto: { randomUUID: () => 'test-capture' },
  Event, Blob, URL, Float32Array, Uint8Array,
  AudioContext: class {
    sampleRate = 48000; state = 'suspended'
    audioWorklet = { addModule: async () => {} }
    constructor() { contexts.push(this) }
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [new Track()] } } }
    async resume() { this.state = 'running' }
    async close() { this.state = 'closed' }
  },
  AudioWorkletNode: class {
    port = { postMessage: data => { this.last = data }, close: () => { this.portClosed = true } }
    constructor() { nodes.push(this) }
    connect() {}
    disconnect() { this.disconnected = true }
  }
})
const makeStream = () => ({
  video: new Track(), audio: [],
  getVideoTracks() { return [this.video] },
  getAudioTracks() { return [...this.audio] },
  addTrack(track) { this.audio.push(track) },
  removeTrack(track) { this.audio = this.audio.filter(item => item !== track) }
})
let stream = makeStream()
await module.exports.attachWindowsScreenAudio(stream)
assert.equal(stream.audio.length, 1)
pcmListener({ id: 'stale', pcm: new Uint8Array(new Float32Array([1, 1]).buffer) })
assert.equal(nodes.at(-1).last, undefined)
pcmListener({ id: 'test-capture', pcm: new Uint8Array(new Float32Array([0.5, -0.25]).buffer) })
assert.equal(nodes.at(-1).last[1], -0.25)
stream.audio[0].stop()
assert.equal(contexts.at(-1).state, 'closed')
assert.ok(nodes.at(-1).disconnected && nodes.at(-1).portClosed)
assert.equal(pcmListener, undefined)
assert.equal(endedListener, undefined)
assert.equal(stopped.length, 1)
stream.audio[0].stop()
assert.equal(stopped.length, 1, 'cleanup is idempotent')
stream = makeStream()
await module.exports.attachWindowsScreenAudio(stream)
let ended = false
stream.audio[0].addEventListener('ended', () => { ended = true })
endedListener({ id: 'test-capture' })
assert.equal(stream.audio.length, 0)
assert.equal(ended, true)
stream = makeStream()
await module.exports.attachWindowsScreenAudio(stream)
stream.video.dispatchEvent(new Event('ended'))
assert.equal(contexts.at(-1).state, 'closed')
fail = true
stream = makeStream()
await assert.rejects(module.exports.attachWindowsScreenAudio(stream), /activation failure/)
assert.equal(stream.audio.length, 0)
assert.equal(contexts.at(-1).state, 'closed')
assert.equal(pcmListener, undefined)
console.log('PASS native track lifecycle: PCM ownership, explicit stop, video end, helper failure, startup rollback and listener/context cleanup')

const captureBundle = await build({ entryPoints: [new URL('../lib/screen-capture.ts', import.meta.url).pathname], bundle: true, write: false, format: 'cjs', platform: 'node' })
const captureModule = { exports: {} }, requests = [], warnings = []
const window = { electronVoice: bridge, voixexWindow: { platform: 'win32', systemAudioExclusionSupported: false } }
let selectedStream, permissionFailure
vm.runInNewContext(captureBundle.outputFiles[0].text, {
  ...globals, window, module: captureModule, exports: captureModule.exports,
  console: { warn: (...args) => warnings.push(args) },
  navigator: { mediaDevices: {
    getSupportedConstraints() { throw new Error('Windows native capture must bypass Chromium constraint gating') },
    async getDisplayMedia(options) { requests.push(options); if (permissionFailure) throw permissionFailure; return selectedStream }
  } }
})
fail = false
selectedStream = makeStream()
const unwanted = new Track()
selectedStream.audio.push(unwanted)
await captureModule.exports.captureScreenWithIsolatedAudio({ frameRate: 30 }, true)
assert.equal(requests.at(-1).audio, false)
assert.equal(requests.at(-1).systemAudio, 'exclude')
assert.equal(unwanted.readyState, 'ended')
assert.equal(selectedStream.audio.length, 1, 'native audio replaces unexpected Chromium audio')
selectedStream.audio[0].stop()
selectedStream = makeStream()
const before = contexts.length
await captureModule.exports.captureScreenWithIsolatedAudio({}, false)
assert.equal(contexts.length, before, 'audio off never starts native capture')
fail = true
await captureModule.exports.captureScreenWithIsolatedAudio({}, true)
assert.equal(selectedStream.audio.length, 0)
assert.equal(warnings.length, 1)
permissionFailure = new Error('permission denied')
await assert.rejects(captureModule.exports.captureScreenWithIsolatedAudio({}, true), /permission denied/)
console.log('PASS production Windows capture routing: bypasses Chromium gates, no duplicate/unsafe tracks, audio off, native failure fallback and permission cancellation')
