import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
const source = readFileSync(new URL('../lib/voice-playout.ts', import.meta.url), 'utf8')
function processor(name) {
  let Processor
  const messages = []
  const context = vm.createContext({ Float32Array, Math, sampleRate: 48000, currentTime: 0,
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: message => messages.push(message) } },
    registerProcessor: (_, ctor) => { Processor = ctor } })
  vm.runInContext(source.match(new RegExp(`const VOICE_${name}_WORKLET_SOURCE = \x60([\\s\\S]*?)\x60`))[1], context)
  const instance = new Processor()
  return { instance, messages, context, send: data => instance.port.onmessage({ data }) }
}
// Quiet voiced tones cross zero often: deleting "near silent" individual samples changes pitch.
const playback = processor('PLAYBACK')
playback.send({ type: 'configure', startThreshold: 960, maxBuffered: 20000 })
const tone = Float32Array.from({ length: 9600 }, (_, i) => 0.009 * Math.sin(2 * Math.PI * 440 * i / 48000))
playback.send({ type: 'push', data: tone })
const played = []
for (let i = 0; i < tone.length / 128; i++) {
  const out = new Float32Array(128)
  playback.instance.process([], [[out]])
  played.push(...out)
}
assert.deepEqual(played, Array.from(tone), 'queued voice retains every sample and its pitch')
assert.equal(playback.instance.catchupDrops, 0)
console.log('PASS queued quiet speech retains sample timing without pitch-changing catch-up')
// Capture and the LiveKit branch must keep running without a renderer callback.
const capture = processor('CAPTURE')
const captured = []
for (let block = 0; block < 375; block++) {
  capture.context.currentTime = block * 128 / 48000
  const input = Float32Array.from({ length: 128 }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 700 * (block * 128 + i) / 48000))
  const out = new Float32Array(128)
  capture.instance.process([[input]], [[out]])
  assert.deepEqual(out, input, 'audio output cannot depend on the message consumer')
  captured.push(...input)
}
assert.equal(capture.messages.length, 50)
assert.ok(capture.messages.every(message => message.data.length === 960))
assert.deepEqual(capture.messages.flatMap(message => Array.from(message.data)), captured)
for (let i = 1; i < capture.messages.length; i++) assert.ok(Math.abs(capture.messages[i].capturedAt - capture.messages[i - 1].capturedAt - 0.02) < 0.003)
console.log('PASS capture produces 50 continuous 20ms frames and audio output without consuming renderer messages')
capture.send({ type: 'gate', enabled: true, muteThreshold: 200, openThreshold: 1000, floorRatio: 0.1, releaseMs: 80 })
for (let i = 0; i < 2000; i++) capture.instance.process([[new Float32Array(128)]], [[new Float32Array(128)]])
assert.equal(capture.instance.zone, 'mute')
console.log('PASS microphone noise gate runs on the audio thread')
