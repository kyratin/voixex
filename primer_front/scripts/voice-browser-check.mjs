import { chromium } from 'playwright'
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const frontend=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const serverRoot=process.env.CAMERA_SERVER_ROOT||resolve(frontend,'../../voixex-camera-server')
const {AccessToken}=createRequire(resolve(serverRoot,'backend/package.json'))('livekit-server-sdk')
const output=mkdtempSync(join(tmpdir(),'voixex-voice-browser-'))
await build({entryPoints:[resolve(frontend,'test/voice-browser-entry.ts')],bundle:true,format:'esm',outfile:join(output,'bundle.js')})
const server=http.createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(join(output,'bundle.js')))}else res.end('<html><body><div id="audio"></div></body></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({...(process.env.CAMERA_CHROME?{executablePath:process.env.CAMERA_CHROME}:{}),headless:true,args:['--autoplay-policy=no-user-gesture-required']})
try{
 const context=await browser.newContext(), pages=[]
 for(let i=0;i<3;i++){
  const page=await context.newPage();pages.push(page);await page.goto(`http://127.0.0.1:${server.address().port}`)
  const token=new AccessToken('devkey','camera-test-secret-local-only',{identity:`voice-${i}`});token.addGrant({room:'voice-browser-test',roomJoin:true,canPublish:true,canSubscribe:true})
  await page.evaluate(async input=>{
   const {WebRtcMediaSession}=await import('/bundle.js')
   window.media=new WebRtcMediaSession({audioSink:document.getElementById('audio'),playRemoteVoice:true})
   await window.media.connect(input)
   window.media.setPlayRemoteVoice(true,[0,1,2].filter(i=>i!==input.index).map(i=>`voice-${i}`))
   const ctx=new AudioContext();window.audioContext=ctx
   const tone=ctx.createOscillator(),gain=ctx.createGain(),output=ctx.createMediaStreamDestination()
   tone.frequency.value=400+input.index*300;gain.gain.value=0.15;tone.connect(gain);gain.connect(output);tone.start();await ctx.resume()
   window.originalMic=output.stream.getAudioTracks()[0]
   await window.media.publishMicTrack(window.originalMic)
  },{url:process.env.CAMERA_LIVEKIT_URL||'ws://127.0.0.1:17880',token:await token.toJwt(),roomName:'voice-browser-test',index:i})
 }
 for(const page of pages){
  await page.waitForFunction(()=>window.media.playingRemoteVoice)
  assert.equal(await page.locator('audio[data-voixex-audio-source="microphone"]').count(),2)
  assert.equal(await page.locator('audio[data-voixex-audio-source="microphone"]').evaluateAll(elements=>elements.every(el=>!el.muted&&!el.paused)),true)
  await page.evaluate(()=>{
   const ctx=window.audioContext, analyser=ctx.createAnalyser();analyser.fftSize=2048
   const pump=ctx.createGain();pump.gain.value=0;analyser.connect(pump);pump.connect(ctx.destination)
   for(const element of document.querySelectorAll('audio[data-voixex-audio-source="microphone"]'))ctx.createMediaStreamSource(element.srcObject).connect(analyser)
   window.receivedAnalyser=analyser
  })
  await page.waitForFunction(()=>{const data=new Float32Array(2048);window.receivedAnalyser.getFloatTimeDomainData(data);return Math.sqrt(data.reduce((sum,value)=>sum+value*value,0)/data.length)>0.02})
 }
 console.log('PASS three LiveKit participants: two playable microphone tracks and decoded audible audio per listener')
 for(const page of pages){
  await page.waitForFunction(()=>Object.values(window.media.localVoiceLevels).some(level=>level>0.02))
  assert.equal(await page.evaluate(()=>Object.keys(window.media.localVoiceLevels)[0]),await page.evaluate(()=>window.media.room.localParticipant.identity))
 }
 await pages[1].evaluate(()=>window.media.setMuted(true))
 assert.deepEqual(await pages[1].evaluate(()=>window.media.localVoiceLevels),{})
 await pages[1].evaluate(()=>window.media.setMuted(false))
 await pages[1].waitForFunction(()=>Object.values(window.media.localVoiceLevels).some(level=>level>0.02))
 console.log('PASS published local microphones expose actual SFU speaking levels; mute clears and unmute restores self activity')
 const listener=pages[0]
 await listener.evaluate(()=>window.media.setPlayRemoteVoice(true,['voice-1','voice-2','voice-missing']))
 assert.equal(await listener.evaluate(()=>window.media.playingRemoteVoice),false)
 assert.equal(await listener.locator('audio[data-voixex-audio-source="microphone"]').evaluateAll(elements=>elements.every(el=>el.muted)),true)
 await listener.evaluate(()=>window.media.setPlayRemoteVoice(true,['voice-1','voice-2']))
 await listener.waitForFunction(()=>window.media.playingRemoteVoice)
 console.log('PASS missing expected speaker keeps compatible audio enabled instead of discarding it')
 for(let i=0;i<12;i++){await listener.evaluate(()=>window.media.setPlayRemoteVoice(false,['voice-1','voice-2']));assert.equal(await listener.evaluate(()=>window.media.playingRemoteVoice),false);await listener.evaluate(()=>window.media.setPlayRemoteVoice(true,['voice-1','voice-2']))}
 await listener.waitForFunction(()=>window.media.playingRemoteVoice)
 assert.equal(await listener.locator('audio[data-voixex-audio-source="microphone"]').count(),2)
 console.log('PASS repeated legacy/WebRTC playback switches do not duplicate or lose audio elements')
 await pages[1].evaluate(()=>window.media.unpublishMic())
 assert.deepEqual(await pages[1].evaluate(()=>window.media.localVoiceLevels),{})
 await listener.waitForFunction(()=>!window.media.playingRemoteVoice)
 assert.equal(await pages[1].evaluate(()=>window.originalMic.readyState),'live')
 await pages[1].evaluate(()=>window.media.publishMicTrack(window.originalMic))
 await pages[1].waitForFunction(()=>Object.values(window.media.localVoiceLevels).some(level=>level>0.02))
 await listener.waitForFunction(()=>window.media.playingRemoteVoice)
 console.log('PASS unpublishing uses fallback and preserves the original processed microphone for republishing')
 await pages[1].evaluate(async()=>{await Promise.all([window.media.publishMicTrack(window.originalMic),window.media.publishMicTrack(window.originalMic),window.media.unpublishMic()]);await window.media.publishMicTrack(window.originalMic)})
 await listener.waitForFunction(()=>window.media.playingRemoteVoice)
 assert.equal(await listener.locator('audio[data-voixex-audio-source="microphone"]').count(),2)
 assert.equal(await pages[1].evaluate(()=>window.originalMic.readyState),'live')
 console.log('PASS overlapping mic publication/mode changes preserve one track and live source')
 await listener.locator('audio[data-voixex-audio-source="microphone"]').first().evaluate(el=>el.pause())
 await listener.waitForFunction(()=>!window.media.playingRemoteVoice)
 await listener.evaluate(()=>window.dispatchEvent(new Event('pointerdown')))
 await listener.waitForFunction(()=>window.media.playingRemoteVoice)
 console.log('PASS paused/blocked voice falls back and resumes after a user gesture')
 await pages[2].evaluate(()=>window.media.disconnect())
 assert.deepEqual(await pages[2].evaluate(()=>window.media.localVoiceLevels),{})
 await listener.waitForFunction(()=>!window.media.playingRemoteVoice)
 await listener.evaluate(()=>window.media.setPlayRemoteVoice(true,['voice-1']))
 await listener.waitForFunction(()=>window.media.playingRemoteVoice)
 console.log('PASS leaving participants trigger fallback until the roster is reconciled')
 for(const page of pages)await page.evaluate(async()=>{await window.media.disconnect();window.originalMic.stop();await window.audioContext.close()})
}finally{await browser.close();server.close();rmSync(output,{recursive:true,force:true})}
