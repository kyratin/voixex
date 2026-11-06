/** Contract regression for the actual capture helper. This does not certify OS audio filtering. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const frontend=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const output=await mkdtemp(join(tmpdir(),'voixex-screen-isolation-'))
const originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator')
const originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window')
const video={frameRate:30,width:{ideal:1280,max:1280},height:{ideal:720,max:720}}
const makeTrack=(settings={},readyState='live')=>({kind:'audio',readyState,stopped:false,getSettings(){return settings},stop(){this.stopped=true;this.readyState='ended'}})
const makeStream=(audio=[])=>({audio:[...audio],getAudioTracks(){return [...this.audio]},removeTrack(track){this.audio=this.audio.filter(item=>item!==track)}})
function install(supported,capture,platformSupported=true){
  const calls=[]
  Object.defineProperty(globalThis,'window',{configurable:true,value:{voixexWindow:{systemAudioExclusionSupported:platformSupported}}})
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{
    getSupportedConstraints:()=>supported,
    getDisplayMedia:async options=>{calls.push(structuredClone(options));return capture(options,calls.length)}
  }}})
  return calls
}
try{
  const bundle=join(output,'capture.mjs')
  await build({entryPoints:[resolve(frontend,'lib/screen-capture.ts')],bundle:true,platform:'node',format:'esm',outfile:bundle})
  const {isolatedScreenCaptureOptions,captureScreenWithIsolatedAudio}=await import(pathToFileURL(bundle).href)
  const assertSafeAudio=options=>{
    assert.deepEqual(options.video,video)
    assert.deepEqual(options.audio,{restrictOwnAudio:true,suppressLocalAudioPlayback:false})
    assert.equal(options.systemAudio,'include')
    assert.equal(options.selfBrowserSurface,undefined,'Audio isolation must not forbid sharing the app picture')
  }
  const assertVideoOnly=options=>{
    assert.deepEqual(options.video,video)
    assert.equal(options.audio,false)
    assert.equal(options.systemAudio,'exclude')
  }
  assertSafeAudio(isolatedScreenCaptureOptions(video,true))
  assertVideoOnly(isolatedScreenCaptureOptions(video,false))

  const isolated=makeTrack({restrictOwnAudio:true}),unconfirmed=makeTrack(),unsafe=makeTrack({restrictOwnAudio:false}),ended=makeTrack({restrictOwnAudio:true},'ended')
  const mixed=makeStream([isolated,unconfirmed,unsafe,ended])
  let calls=install({restrictOwnAudio:true},()=>mixed)
  assert.equal(await captureScreenWithIsolatedAudio(video,true),mixed)
  assertSafeAudio(calls[0]);assert.deepEqual(mixed.getAudioTracks(),[isolated])
  assert.equal(isolated.stopped,false)
  assert.ok([unconfirmed,unsafe,ended].every(track=>track.stopped))
  console.log('PASS supported capture requests own-audio exclusion and preserves local playback; only confirmed live audio survives')

  for(const constraints of [{restrictOwnAudio:false},{}]){
    const track=makeTrack({restrictOwnAudio:true}),stream=makeStream([track])
    calls=install(constraints,()=>stream)
    await captureScreenWithIsolatedAudio(video,true)
    assert.equal(calls.length,1);assertVideoOnly(calls[0]);assert.equal(stream.getAudioTracks().length,0);assert.equal(track.stopped,true)
  }
  console.log('PASS unsupported or unknown own-audio isolation captures video only and removes unexpected audio')

  {
    const track=makeTrack({restrictOwnAudio:true}),stream=makeStream([track])
    calls=install({restrictOwnAudio:true},()=>stream,false)
    await captureScreenWithIsolatedAudio(video,true)
    assertVideoOnly(calls[0]);assert.equal(stream.getAudioTracks().length,0);assert.equal(track.stopped,true)
  }
  console.log('PASS platform exclusion capability=false overrides browser constraint support')

  {
    const stream=makeStream(),failure=new Error('isolated audio unavailable')
    calls=install({restrictOwnAudio:true},(_options,attempt)=>{if(attempt===1)throw failure;return stream})
    assert.equal(await captureScreenWithIsolatedAudio(video,true),stream)
    assert.equal(calls.length,2);assertSafeAudio(calls[0]);assertVideoOnly(calls[1])
  }
  {
    // Even a non-conforming capture provider must not smuggle audio through a video-only retry.
    const track=makeTrack({restrictOwnAudio:true}),stream=makeStream([track])
    calls=install({restrictOwnAudio:true},(_options,attempt)=>{if(attempt===1)throw new Error('retry picture');return stream})
    await captureScreenWithIsolatedAudio(video,true)
    assertVideoOnly(calls[1]);assert.equal(stream.getAudioTracks().length,0);assert.equal(track.stopped,true)
  }
  console.log('PASS isolated-audio rejection retries video only; retry never retains or requests unrestricted audio')

  {
    const track=makeTrack({restrictOwnAudio:true}),stream=makeStream([track])
    calls=install({restrictOwnAudio:true},()=>stream)
    await captureScreenWithIsolatedAudio(video,false)
    assert.equal(calls.length,1);assertVideoOnly(calls[0]);assert.equal(stream.getAudioTracks().length,0);assert.equal(track.stopped,true)
  }
  {
    const denied=new Error('screen permission denied')
    calls=install({},()=>{throw denied})
    await assert.rejects(()=>captureScreenWithIsolatedAudio(video,true),error=>error===denied)
    assert.equal(calls.length,1)
  }
  for(const name of ['NotAllowedError','AbortError','InvalidStateError']){
    const cancelled=new DOMException('capture cancelled',name)
    calls=install({restrictOwnAudio:true},()=>{throw cancelled})
    await assert.rejects(()=>captureScreenWithIsolatedAudio(video,true),error=>error===cancelled)
    assert.equal(calls.length,1,'Cancellation must not open a second picker')
  }
  console.log('PASS audio-disabled requests stay video only; video permission failures propagate without repeated prompts')
}finally{
  if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);else delete globalThis.navigator
  if(originalWindow)Object.defineProperty(globalThis,'window',originalWindow);else delete globalThis.window
  await rm(output,{recursive:true,force:true})
}
