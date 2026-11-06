import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowsScreenAudio } from '../dist/windows-screen-audio.js'

// A real child process exercises fragmented pipes and teardown without recording audio.
if (process.platform === 'win32') {
  console.log('SKIP pipe fixture (POSIX shebang); native compilation runs in Windows CI')
  process.exit(0)
}
const temp = await mkdtemp(join(tmpdir(), 'voixex-native-audio-'))
const executable = join(temp, 'fixture')
await writeFile(executable, `#!/usr/bin/env node
const mode = process.env.VOIXEX_AUDIO_FIXTURE;
if (mode === 'fail') { process.stderr.write('ERROR activation rejected\\n'); process.exit(1); }
process.stderr.write('REA');
setTimeout(() => {
  process.stderr.write('DY 48000 2 f32\\n');
  const pcm = Buffer.alloc(7680); for (let i=0; i<1920; i++) pcm.writeFloatLE(i%2 ? -0.25 : 0.5, i*4);
  process.stdout.write(pcm.subarray(0, 3));
  setTimeout(() => process.stdout.write(pcm.subarray(3)), 10);
}, 10);
setInterval(() => {}, 1000);
`)
await chmod(executable, 0o755)
class Owner extends EventEmitter {
  constructor(id) { super(); this.id = id; this.messages = []; this.destroyed = false }
  isDestroyed() { return this.destroyed }
  send(channel, payload) { this.messages.push([channel, payload]); this.emit(channel, payload) }
}
const service = new WindowsScreenAudio(executable)
const originalMode = process.env.VOIXEX_AUDIO_FIXTURE
try {
  const owner = new Owner(1), other = new Owner(2)
  const audio = once(owner, 'screenAudio:pcm', { signal: AbortSignal.timeout(3000) })
  await service.start(owner, 'first')
  const [packet] = await audio
  assert.equal(packet.id, 'first')
  const samples = new Float32Array(packet.pcm.buffer)
  assert.equal(samples.length, 1920)
  assert.equal(samples[0], 0.5)
  assert.equal(samples[1], -0.25)
  service.stop(other, 'first')
  service.stop(owner, 'stale')
  assert.equal(owner.messages.filter(([channel]) => channel === 'screenAudio:ended').length, 0)
  await service.start(owner, 'second')
  assert.equal(owner.messages.at(-1)[1].id, 'first')
  service.stop(owner, 'first') // A late stop cannot kill the replacement capture.
  assert.equal(owner.messages.filter(([channel]) => channel === 'screenAudio:ended').length, 1)
  owner.emit('did-start-navigation', {}, 'app://bundle', false, true)
  assert.equal(owner.messages.at(-1)[1].id, 'second')
  assert.equal(owner.listenerCount('destroyed'), 0)
  process.env.VOIXEX_AUDIO_FIXTURE = 'fail'
  await assert.rejects(service.start(owner, 'failure'), /activation rejected/)
  await assert.rejects(service.start(owner, '../bad'), /Invalid/)
  await assert.rejects(new WindowsScreenAudio(join(temp, 'missing')).start(owner, 'missing'), /ENOENT/)
  delete process.env.VOIXEX_AUDIO_FIXTURE
  await service.start(owner, 'close')
  owner.destroyed = true
  owner.emit('destroyed')
  assert.equal(owner.listenerCount('did-start-navigation'), 0)
  console.log('PASS native audio pipe: fragmented PCM/status, failures, capture ownership, stale stops, replacement, navigation and window cleanup')
} finally {
  service.stopAll()
  if (originalMode === undefined) delete process.env.VOIXEX_AUDIO_FIXTURE
  else process.env.VOIXEX_AUDIO_FIXTURE = originalMode
  await rm(temp, { recursive: true, force: true })
}
