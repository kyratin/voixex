import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const serverRoot = process.env.CAMERA_SERVER_ROOT || resolve(frontend, '../../voixex-camera-server')
const require = createRequire(resolve(serverRoot, 'backend/package.json'))
const output = mkdtempSync(join(tmpdir(), 'voixex-camera-browser-'))
await build({ entryPoints: [resolve(frontend, 'test/camera-browser-entry.tsx')], bundle: true, format: 'esm', outfile: join(output, 'bundle.js') })
const { AccessToken } = require('livekit-server-sdk')
const server = http.createServer((req,res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type','text/javascript'); res.end(readFileSync(join(output, 'bundle.js'))); return }
  res.end('<html><body><div id="audio"></div><video id="camera" autoplay muted playsinline></video><video id="screen" autoplay muted playsinline></video></body></html>')
})
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
const url = `http://127.0.0.1:${server.address().port}`
const relay = spawn(process.execPath, [resolve(serverRoot, 'backend/test/camera-transports.mjs')], {
  env: { ...process.env, CAMERA_BROWSER: '1', CAMERA_CLIENT_ROOT: resolve(frontend, '..') }, stdio: ['ignore','pipe','pipe']
})
const relayUrl = await new Promise((resolve, reject) => {
  let output = ''
  const timer = setTimeout(() => reject(new Error('Camera relay did not start')), 15000)
  relay.stdout.on('data', data => { output += data.toString(); const match = output.match(/BROWSER_RELAY_READY (http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]) } })
  relay.stderr.on('data', data => process.stderr.write(data))
  relay.on('exit', code => { clearTimeout(timer); reject(new Error(`Camera relay exited: ${code}`)) })
})
const browser = await chromium.launch({ ...(process.env.CAMERA_CHROME ? { executablePath: process.env.CAMERA_CHROME } : {}), headless: true, args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'] })
try {
  const context = await browser.newContext({ permissions: ['camera','microphone'] })
  const pages = [await context.newPage(), await context.newPage()]
  for (let i=0;i<2;i++) {
    pages[i].on("console", msg => { if (msg.type() === "error") console.log(`browser-${i}:`,msg.text()) });
    await pages[i].goto(url)
    const token = new AccessToken('devkey','camera-test-secret-local-only',{identity:`camera-${i}`})
    token.addGrant({room:'camera-test',roomJoin:true,canPublish:true,canSubscribe:true})
    await pages[i].evaluate(async input => {
      const { WebRtcMediaSession } = await import('/bundle.js')
      window.events = []
      window.media = new WebRtcMediaSession({
        audioSink: document.getElementById('audio'),
        onRemoteCamera(identity,stream) {
          window.events.push({type:'camera',identity,active:!!stream})
          const video = document.getElementById('camera'); video.srcObject=stream
          if (stream) void video.play()
        },
        onRemoteVideo(active,identity) { window.events.push({type:'screen',identity,active}) }
      })
      await window.media.connect(input)
      window.media.bindRemoteScreenVideo(document.getElementById('screen'))
    },{url:process.env.CAMERA_LIVEKIT_URL || 'ws://127.0.0.1:17880',token:await token.toJwt(),roomName:'camera-test'})
  }
  await pages[0].evaluate(async () => {
    window.capture = await navigator.mediaDevices.getUserMedia({video:true,audio:false})
    await window.media.publishCamera(window.capture.getVideoTracks()[0])
  })
  await pages[1].waitForFunction(() => document.getElementById('camera').videoWidth > 0, {timeout:20000})
  console.log('PASS LiveKit camera: real capture, publication, subscription, decoded video')
  await pages[0].evaluate(async () => {
    const canvas=document.createElement('canvas'); canvas.width=640;canvas.height=360
    const ctx=canvas.getContext('2d');ctx.fillStyle='green';ctx.fillRect(0,0,640,360)
    window.screenCapture=canvas.captureStream(10); window.drawTimer=setInterval(()=>{ctx.fillStyle=`rgb(${Math.floor(Math.random()*255)},128,0)`;ctx.fillRect(0,0,640,360)},100)
    await window.media.publishScreenStream(window.screenCapture)
  })
  await pages[1].waitForFunction(() => document.getElementById('screen').videoWidth > 0, {timeout:20000})
  assert.ok(await pages[1].evaluate(() => document.getElementById('camera').videoWidth > 0))
  console.log('PASS camera and screen share coexist without replacing each other')
  await pages[0].evaluate(() => window.media.stopCamera())
  await pages[1].waitForFunction(() => window.events.some(e=>e.type==='camera'&&!e.active))
  assert.ok(await pages[1].evaluate(() => document.getElementById('screen').videoWidth > 0))
  assert.equal(await pages[0].evaluate(() => window.capture.getVideoTracks()[0].readyState),'live')
  console.log('PASS stopping SFU camera preserves screen and original capture for legacy transport')
  await pages[0].evaluate(async () => { await window.media.publishCamera(window.capture.getVideoTracks()[0]); await window.media.disconnect() })
  await pages[1].waitForFunction(() => document.getElementById('camera').srcObject === null)
  console.log('PASS disconnect clears remote camera')
  await pages[1].evaluate(()=>window.media.disconnect())
  const webVoice = await context.newPage()
  await webVoice.goto(url)
  await webVoice.evaluate(async relayUrl => {
    const { WebVoiceEngine, CameraAssembler, fragmentCamera } = await import('/bundle.js')
    const input = await (await fetch(`${relayUrl}/test/token`)).json()
    window.engine = new WebVoiceEngine()
    window.receivedCamera = null
    const assembler = new CameraAssembler()
    window.engine.setOnCameraPacket(packet => {
      const n = packet[0], sender = new TextDecoder().decode(packet.subarray(1,n+1))
      const frame = assembler.push(sender, packet.subarray(n+1), performance.now())
      if (frame) window.receivedCamera = {sender, bytes: Array.from(frame)}
    })
    await window.engine.connect(input); window.engine.joinRoom('room-a')
    const data = new Uint8Array(9000).fill(33); data.set([255,216]); data.set([255,217],8998)
    for (const packet of fragmentCamera(data,200,1,2000)) { await window.engine.sendCameraPacket(packet); await new Promise(resolve=>setTimeout(resolve,2)) }
  }, relayUrl)
  let sent = []
  for (let i=0; i<100; i++) { sent = await (await fetch(`${relayUrl}/test/frames`)).json(); if (sent.length) break; await new Promise(resolve=>setTimeout(resolve,20)) }
  const expected = Buffer.alloc(9000,33); expected.set([255,216]); expected.set([255,217],8998)
  assert.equal(sent[0], expected.toString('base64'))
  await fetch(`${relayUrl}/test/send`)
  await webVoice.waitForFunction(() => !!window.receivedCamera)
  assert.deepEqual(await webVoice.evaluate(()=>window.receivedCamera.bytes), [...expected])
  assert.equal(await webVoice.evaluate(()=>window.receivedCamera.sender),'peer-tcp')
  await webVoice.evaluate(()=>window.engine.close())
  console.log('PASS browser WebCrypto/WebSocket camera interoperates with desktop TCP in both directions')
  const controller = await context.newPage()
  await controller.goto(url)
  await controller.evaluate(async () => {
    const { mountCameraHarness } = await import('/bundle.js')
    window.fixture = mountCameraHarness()
    window.realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    window.sentPackets = 0
    window.cameraFrameTimes = []
    window.electronVoice = { sendCameraPacket: packet => { window.sentPackets++; const data = Uint8Array.from(atob(packet), c => c.charCodeAt(0)); if (new DataView(data.buffer).getUint16(20) === 0) window.cameraFrameTimes.push(performance.now()) }, onCameraPacket: () => () => {} }
  })
  await controller.waitForFunction(() => window.cameraControls?.supported)
  await controller.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.resolveCamera = resolve })
    window.cameraControls.toggle()
  })
  await controller.waitForFunction(() => !!window.resolveCamera)
  await controller.evaluate(async () => {
    window.fixture.room('room-b')
    window.lateCapture = await window.realGetUserMedia({video:true})
    window.resolveCamera(window.lateCapture)
  })
  await controller.waitForFunction(() => window.lateCapture.getVideoTracks()[0].readyState === 'ended')
  assert.equal(await controller.evaluate(() => window.cameraControls.enabled), false)
  console.log('PASS leaving a room while permission/capture is pending releases the late camera')
  await controller.waitForFunction(() => window.cameraControls.supported)
  await controller.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied','NotAllowedError') }
    window.cameraControls.toggle()
  })
  await controller.waitForFunction(() => window.cameraControls.error === 'NotAllowedError')
  assert.equal(await controller.evaluate(() => window.cameraControls.busy), false)
  console.log('PASS permission denial clears busy state and exposes a recoverable error')
  await controller.evaluate(() => { navigator.mediaDevices.getUserMedia = window.realGetUserMedia; window.cameraControls.toggle() })
  await controller.waitForFunction(() => window.cameraControls.enabled && window.sentPackets > 0)
  await controller.waitForFunction(() => window.cameraFrameTimes.length >= 40)
  const fps = await controller.evaluate(() => {
    const times = window.cameraFrameTimes.slice(-30)
    return (times.length - 1) * 1000 / (times.at(-1) - times[0])
  })
  assert.ok(fps >= 20 && fps <= 36, `Compatibility camera should target 30 fps, observed ${fps.toFixed(1)}`)
  console.log(`PASS compatibility camera scheduling: ${fps.toFixed(1)} fps with real browser capture/encoding`)
  await controller.evaluate(() => { window.activeCapture = window.cameraControls.local; window.fixture.unmount() })
  await controller.waitForFunction(() => window.activeCapture.getVideoTracks()[0].readyState === 'ended')
  console.log('PASS real camera sends compatibility packets; unmount releases capture')
} finally { await browser.close(); relay.kill('SIGTERM'); server.close(); rmSync(output, { recursive: true, force: true }) }
