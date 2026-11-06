/** Actual Chromium video/MediaStream ownership regression for WebRtcMediaSession pop-outs. */
import { chromium } from 'playwright'
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
const frontend=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const output=await mkdtemp(join(tmpdir(),'voixex-popup-continuity-'))
let browser,server
try{
  const bundle=join(output,'bundle.js')
  await build({stdin:{contents:'export { WebRtcMediaSession } from "./lib/webrtc-media.ts"; export { RemoteVideoTrack } from "livekit-client";',resolveDir:frontend},bundle:true,format:'esm',outfile:bundle})
  const js=await readFile(bundle)
  server=http.createServer((req,res)=>{
    if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(js)}
    else res.end('<!doctype html><body><div id="audio"></div><video id="main" muted autoplay playsinline></video></body>')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  browser=await chromium.launch({...(process.env.CAMERA_CHROME?{executablePath:process.env.CAMERA_CHROME}:{}),headless:true,args:['--autoplay-policy=no-user-gesture-required','--disable-renderer-backgrounding','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows']})
  const page=await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const result=await page.evaluate(async()=>{
    const {WebRtcMediaSession,RemoteVideoTrack}=await import('/bundle.js')
    const require=(condition,message)=>{if(!condition)throw new Error(message)}
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
    async function until(check,label){const deadline=performance.now()+4000;while(!check()&&performance.now()<deadline)await delay(10);require(check(),label)}
    const captures=[],timers=[]
    const canvasStream=(base)=>{
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180
      const ctx=canvas.getContext('2d');let frame=0
      const draw=()=>{ctx.fillStyle=`rgb(${base[0]},${base[1]},${base[2]})`;ctx.fillRect(0,0,320,180);ctx.fillStyle='white';ctx.fillText(String(frame++),4,16)}
      draw();const stream=canvas.captureStream(30);captures.push(stream);timers.push(setInterval(draw,30));return stream
    }
    const first=canvasStream([36,87,184]),second=canvasStream([45,195,65]),foreign=canvasStream([195,60,45])
    const firstSource=first.getVideoTracks()[0],secondSource=second.getVideoTracks()[0],foreignSource=foreign.getVideoTracks()[0]
    const session=new WebRtcMediaSession({audioSink:document.getElementById('audio')})
    // The real SDK RemoteVideoTrack supplies attachment behavior; the input is a real canvas track.
    const remote=track=>new RemoteVideoTrack(track,crypto.randomUUID(),null)
    session.remoteScreenTrack=remote(firstSource)
    const main=document.getElementById('main')
    session.bindRemoteScreenVideo(main)
    const popup=window.open('about:blank','voixex-popup-continuity')
    require(popup,'Browser must open the test pop-out')
    const video=popup.document.createElement('video');video.muted=true;video.autoplay=true;video.playsInline=true;popup.document.body.appendChild(video)
    const probe=document.createElement('canvas');probe.width=probe.height=1;const pixels=probe.getContext('2d',{willReadFrequently:true})
    const sample=()=>{pixels.drawImage(video,160,90,1,1,0,0,1,1);return [...pixels.getImageData(0,0,1,1).data]}
    let frames=0,stopFrameCounter=false
    const countFrame=()=>{if(stopFrameCounter)return;frames++;video.requestVideoFrameCallback(countFrame)}
    try{
      session.bindPopupScreenVideo(video)
      await until(()=>video.videoWidth===320&&video.readyState>=2,'Pop-out must decode its first frame')
      video.requestVideoFrameCallback(countFrame)
      const ownedStream=video.srcObject,ownedClone=ownedStream.getVideoTracks()[0]
      require(ownedClone!==firstSource,'Pop-out must own a clone, not the source track')
      for(let i=0;i<100;i++){
        session.bindPopupScreenVideo(video)
        session.rebindRemoteScreenVideo(main)
        require(video.srcObject===ownedStream,'UI refresh must preserve the same pop-out MediaStream')
        require(video.srcObject.getVideoTracks()[0]===ownedClone&&ownedClone.readyState==='live','UI refresh must preserve the same live clone')
        require(firstSource.readyState==='live','UI refresh must never stop the original screen source')
        const rgba=sample();require(rgba[2]>120&&rgba[0]+rgba[1]+rgba[2]>200,`Refresh ${i} produced a black/incorrect frame: ${rgba}`)
        await delay(20)
      }
      require(frames>=20,`Pop-out must keep decoding new frames, observed ${frames}`)
      const continuousFrames=frames
      session.remoteScreenTrack=remote(secondSource)
      session.bindPopupScreenVideo(video)
      session.rebindRemoteScreenVideo(main)
      require(ownedClone.readyState==='ended','A real source change must release the old owned clone')
      require(firstSource.readyState==='live','Replacing the pop-out source must preserve the old publisher track')
      const replacement=video.srcObject,replacementClone=replacement.getVideoTracks()[0]
      require(replacement!==ownedStream&&replacementClone!==ownedClone&&replacementClone.readyState==='live','A real source change must create a new live owned stream')
      await until(()=>video.readyState>=2&&sample()[1]>150&&sample()[2]<120,'New screen source must decode green pixels')
      // Another presentation owner may replace srcObject before this class is cleaned up.
      video.srcObject=foreign
      session.unbindPopupScreenVideo()
      require(replacementClone.readyState==='ended','Cleanup must release the last owned clone')
      require(video.srcObject===foreign&&foreignSource.readyState==='live','Cleanup must not remove or stop a stream owned by somebody else')
      require(firstSource.readyState==='live'&&secondSource.readyState==='live','Cleanup must preserve both original publisher tracks')
      session.bindPopupScreenVideo(video)
      await until(()=>video.srcObject!==foreign&&video.videoWidth===320&&video.readyState>=2,'Reopening must restore current remote video')
      const reopenedClone=video.srcObject.getVideoTracks()[0]
      session.unbindPopupScreenVideo()
      require(reopenedClone.readyState==='ended'&&video.srcObject===null,'Normal close must release its own clone and clear its own presentation')
      require(secondSource.readyState==='live'&&foreignSource.readyState==='live','Closing must preserve sources outside pop-out ownership')
      return {refreshes:100,decodedFrames:continuousFrames,blackFrames:0,sourceChange:'passed',foreignOwnership:'passed',reopen:'passed'}
    }finally{
      stopFrameCounter=true;session.unbindPopupScreenVideo();session.bindRemoteScreenVideo(null)
      popup.close();for(const timer of timers)clearInterval(timer);for(const stream of captures)stream.getTracks().forEach(track=>track.stop())
    }
  })
  assert.equal(result.refreshes,100)
  console.log('PASS real Chromium pop-out continuity and clone ownership',JSON.stringify(result))
}finally{
  await browser?.close()
  if(server)await new Promise(resolve=>server.close(resolve))
  await rm(output,{recursive:true,force:true})
}
