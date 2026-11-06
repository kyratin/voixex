/** Real Chromium AudioEncoder/WebCrypto recovery after late output and room changes. */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = await mkdtemp(join(tmpdir(), 'voixex-codec-recovery-'))
let browser, server
try {
  const bundle = join(output, 'engine.js')
  await build({stdin:{contents:[
    'export { WebVoiceEngine } from "./lib/web-voice/engine.ts";',
    'export { deriveMediaKey, decryptPacket } from "./lib/web-voice/protocol.ts";'
  ].join('\n'),resolveDir:frontend},bundle:true,format:'esm',outfile:bundle})
  const script = await readFile(bundle)
  server = http.createServer((req,res) => {
    if(req.url==='/engine.js'){res.setHeader('Content-Type','text/javascript');res.end(script)}
    else res.end('<!doctype html><title>WebCodecs queue recovery</title>')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  browser = await chromium.launch({...(process.env.CAMERA_CHROME?{executablePath:process.env.CAMERA_CHROME}:{}),headless:true})
  const page = await browser.newPage()
  page.on('pageerror',error=>console.error('browser:',error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const result = await page.evaluate(async()=>{
    const {WebVoiceEngine,deriveMediaKey,decryptPacket}=await import('/engine.js')
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
    const require=(condition,message)=>{if(!condition)throw new Error(message)}
    require(typeof AudioEncoder==='function','Chromium must provide actual AudioEncoder')
    const engine=new WebVoiceEngine(),packets=[]
    const seed=btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
    const key=await deriveMediaKey(seed)
    engine.key=key;engine.connected=true;engine.roomId='room-a'
    engine.ws={readyState:1,bufferedAmount:0,send(packet){packets.push(packet)},close(){}}
    await engine.prepareUplink()
    require(engine.getStats().uplinkCodec==='opus','Test must start with real Opus, not PCM')
    let phase=0
    const capture=()=>{const pcm=new Int16Array(960);for(let i=0;i<960;i++){pcm[i]=Math.round(Math.sin(phase)*5000);phase+=2*Math.PI*500/48000}engine.sendPcm16(pcm)}
    const run=async count=>{for(let i=0;i<count;i++){capture();await delay(20)}}
    const audioCount=async()=>{const decoded=await Promise.all(packets.map(packet=>decryptPacket(key,packet)));return decoded.filter(packet=>packet&&(packet.kind===0||packet.kind===3)).length}
    try {
      await run(20)
      require(await audioCount()>8,'Initial real Opus capture must transmit')
      // Hold the JS thread after submitting real encoder work. Its callback cannot run
      // before the80ms deadline, reproducing a heavily loaded WebView without fake codecs.
      let lastBefore=await audioCount()
      for(let i=0;i<3;i++){
        capture()
        const until=performance.now()+120
        while(performance.now()<until){}
        await delay(20)
      }
      await run(25)
      require(await audioCount()>lastBefore+10,'Audio must recover after repeated >80ms output lateness')
      const lateStats=engine.getStats()
      require(lateStats.uplinkLateFrames>0||lateStats.uplinkFallbacks>0,'Stall must exercise actual late-output recovery')
      const afterStall=await audioCount()
      engine.joinRoom('room-b')
      capture() // Queue actual encoder/WebCrypto work, then cancel it immediately.
      engine.joinRoom('room-c')
      await delay(60)
      const roomCStart=packets.length
      await run(20)
      const decoded=await Promise.all(packets.slice(roomCStart).map(packet=>decryptPacket(key,packet)))
      require(decoded.some(packet=>packet?.roomId==='room-c'&&(packet.kind===0||packet.kind===3)),'New room must receive audio')
      require(decoded.every(packet=>packet?.roomId==='room-c'),'No old-room packet may cross the room transition')
      // A connection reset uses the same cancellation path as a room change.
      engine.resetOutgoing()
      const beforeReconnect=await audioCount()
      await run(20)
      require(await audioCount()>beforeReconnect+8,'Capture must recover after connection cancellation/reset')
      const RealAudioEncoder=globalThis.AudioEncoder
      // Keep the real browser codec, but swallow its callbacks to model a stalled platform
      // bridge. The capture watchdog must release the bounded metadata queue into PCM.
      function NoOutputEncoder(init){return new RealAudioEncoder({...init,output(){}})}
      NoOutputEncoder.isConfigSupported=RealAudioEncoder.isConfigSupported.bind(RealAudioEncoder)
      const stalled=new WebVoiceEngine(),stalledPackets=[]
      try {
        globalThis.AudioEncoder=NoOutputEncoder
        stalled.key=key;stalled.connected=true;stalled.roomId='watchdog-room'
        stalled.ws={readyState:1,bufferedAmount:0,send(packet){stalledPackets.push(packet)},close(){}}
        await stalled.prepareUplink()
        require(stalled.getStats().uplinkCodec==='opus','Missing-output case must start in real Opus')
        for(let i=0;i<20;i++){
          const pcm=new Int16Array(960);for(let j=0;j<960;j++)pcm[j]=Math.round(Math.sin(j*2*Math.PI*500/48000)*5000)
          stalled.sendPcm16(pcm);await delay(20)
          require(stalled.pendingFlags.size<=4,'Missing outputs must never grow metadata beyond four')
        }
        const stats=stalled.getStats()
        require(stats.uplinkCodec==='pcm'&&stats.uplinkFallbacks>0,'Missing outputs must trigger bounded-time PCM fallback')
        const sent=await Promise.all(stalledPackets.map(packet=>decryptPacket(key,packet)))
        require(sent.filter(packet=>packet?.kind===0).length>3,'Watchdog fallback must transmit real PCM voice')
      }finally{stalled.close();globalThis.AudioEncoder=RealAudioEncoder}
      return {initialCodec:'opus',afterStallCodec:lateStats.uplinkCodec,lateFrames:lateStats.uplinkLateFrames,fallbacks:lateStats.uplinkFallbacks,audioFrames:await audioCount(),afterStall,missingOutputWatchdog:'passed'}
    }finally{engine.close()}
  })
  assert.equal(result.initialCodec,'opus')
  console.log('PASS actual Chromium Opus/WebCrypto: late-output recovery, room isolation, reconnect cancellation',JSON.stringify(result))
}finally{
  await browser?.close()
  if(server)await new Promise(resolve=>server.close(resolve))
  await rm(output,{recursive:true,force:true})
}
