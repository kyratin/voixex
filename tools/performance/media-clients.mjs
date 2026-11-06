import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import dgram from 'node:dgram'
import { lookup } from 'node:dns/promises'
import { summarize } from './summarize.mjs'
import net from 'node:net'
import { monitorEventLoopDelay } from 'node:perf_hooks'
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
export function quantile(a,p){if(!a.length)return null;const s=[...a].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(p*s.length))]}
if(isMainThread){
 const fs=await import('node:fs/promises'), c=JSON.parse(await fs.readFile(process.argv[2],'utf8'))
 const peers=await (await fetch(`${c.api}/setup`,{method:'POST',body:JSON.stringify(c)})).json()
 for(const p of peers){const active=peers.filter(q=>q.room===p.room&&q.active).length;p.expected=active>0&&(!p.active||active>1)}
 const start=Date.now()+(c.startDelayMs||3500), measure=start+(c.warmupSec||5)*1000, stop=measure+c.seconds*1000
 const workers=[]
 const generatedPeers=c.observer?peers.slice(0,-1):peers
 let observer=null,observerFrames=0,observerMarkers=[],observerAudio=[],observerFrequencies=[],lastObserverMarker=-1,observerGaps=[],lastObserverAt=0
 if(c.observer){
  const {VoiceEngine}=await import(pathToFileURL(`${c.clientRoot}/dist/index.js`)), p=peers.at(-1)
  observer=new VoiceEngine({host:new URL(c.api).hostname,port:c.port,apiBase:c.api,mediaToken:p.token,mediaSeed:p.seed,transport:"udp"})
  observer.setOnPcm16Frame(pcm=>{const now=Date.now();if(now<measure||now>=stop)return;observerFrames++;if(now<measure+5000)observerAudio.push(Buffer.from(pcm));if(lastObserverAt)observerGaps.push(now-lastObserverAt);lastObserverAt=now;let re=0,im=0;for(let i=0;i<960;i++){const x=pcm.readInt16LE(i*2);re+=x*Math.cos(i*2*Math.PI*500/48000);im+=x*Math.sin(i*2*Math.PI*500/48000)}if(Math.hypot(re,im)/960>1000){let best=0,hz=0;for(const f of [480,490,500,510,520]){let r=0,m=0;for(let i=0;i<960;i++){const v=pcm.readInt16LE(i*2);r+=v*Math.cos(i*2*Math.PI*f/48000);m+=v*Math.sin(i*2*Math.PI*f/48000)}const amp=Math.hypot(r,m);if(amp>best){best=amp;hz=f}}observerFrequencies.push(hz);const marker=Math.floor((now-start)/1500),latency=now-(start+marker*1500);if(marker!==lastObserverMarker&&latency<1000){observerMarkers.push(latency);lastObserverMarker=marker}}})
  await observer.connect();observer.joinRoom(p.room)
 }
 for(let i=0;i<generatedPeers.length;i+=20)workers.push(new Promise((resolve,reject)=>{
  const worker=new Worker(new URL(import.meta.url),{workerData:{...c,peers:generatedPeers.slice(i,i+20),offset:i,start,measure,stop}})
  worker.once('message',resolve);worker.once('error',reject);worker.on('exit',code=>{if(code)reject(new Error(`client worker exit ${code}`))})
 }))
 const reports=await Promise.all(workers)
 const observerMetrics=observer?{frames:observerFrames,fps:observerFrames/c.seconds,dominantHzMedian:quantile(observerFrequencies,.5),dominantHzMin:Math.min(...observerFrequencies),dominantHzMax:Math.max(...observerFrequencies),markerLatencyP50Ms:quantile(observerMarkers,.5),markerLatencyP95Ms:quantile(observerMarkers,.95),audioGapP99Ms:quantile(observerGaps,.99),stats:observer.getStats()}:null
 observer?.close()
 if(observerAudio.length){const pcm=Buffer.concat(observerAudio),header=Buffer.alloc(44);header.write("RIFF");header.writeUInt32LE(36+pcm.length,4);header.write("WAVEfmt ",8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(48000,24);header.writeUInt32LE(96000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write("data",36);header.writeUInt32LE(pcm.length,40);await fs.writeFile(c.output.replace(/\.raw\.json$/, ".wav"),Buffer.concat([header,pcm]))}
 const server=await(await fetch(`${c.api}/metrics`)).json()
 const output={config:c,start,measure,stop,clientReports:reports,server,observer:observerMetrics}
 await fs.writeFile(c.output,JSON.stringify(output))
 const summaries=reports.flatMap(r=>r.peers);
 for(const p of summaries){if(p.probeSent>c.seconds+2)throw new Error(`probe generator oversent: ${p.probeSent}`);if(p.audioSent>c.seconds*50+2)throw new Error(`audio generator oversent: ${p.audioSent}`);if(p.cameraFramesSent>c.seconds*30+2)throw new Error(`camera generator oversent: ${p.cameraFramesSent}`)}
 console.log(JSON.stringify(summarize(output)))
 process.exit(0)
}else{
 const c=workerData, protocol=await import(pathToFileURL(`${c.backend}/dist/media/protocol.js`)), {OpusCodec:Opus}=await import(pathToFileURL(`${c.backend}/dist/media/opus-codec.js`))
 const {WebSocket}=await import(pathToFileURL(`${c.backend}/node_modules/ws/wrapper.mjs`)), {fragmentCamera}=await import(pathToFileURL(`${c.backend}/dist/media/camera-protocol.js`))
 const {address:mediaHost}=await lookup(new URL(c.api).hostname)
 const loop=monitorEventLoopDelay({resolution:5});loop.enable()
 const Gate=c.clientSilenceGate?(await import(pathToFileURL(`${c.clientRoot}/dist/silence-gate.js`))).SilenceGate:null
 const peers=[],rtts=[],gaps=[],latencies=[]
 let frame=0,skipped=0,cameraFrame=0
 const frames=[]
 const encoder=new Opus(48000,1,Opus.Application.VOIP);encoder.setBitrate(32000)
 for(let bank=0;bank<(c.peers.some(p=>p.active)||c.openMicSilent?10:0);bank++){
  const list=[]
  for(let t=0;t<75;t++){
   const pcm=Buffer.alloc(1920)
   for(let i=0;i<960;i++){
    const sample=t*960+i
    const x=bank===9 ? 0 : bank===0 ? (t%75<5?6000*Math.sin(sample*2*Math.PI*500/48000):0) : (1800/Math.sqrt(Math.max(1,c.speakers)))*(Math.sin(sample*2*Math.PI*(1000*bank)/48000)+.25*Math.sin(sample*2*Math.PI*(1000*bank+1000)/48000))
    pcm.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(x))),i*2)
   }
   list.push(Buffer.from(encoder.encode(pcm,960)))
  }
  frames.push(list)
 }
 encoder.delete()
 const power=pcm=>{let re=0,im=0;for(let i=0;i<960;i++){const v=pcm.readInt16LE(i*2);re+=v*Math.cos(i*2*Math.PI*500/48000);im+=v*Math.sin(i*2*Math.PI*500/48000)}return Math.hypot(re,im)/960}
 for(let j=0;j<c.peers.length;j++){
  const source=c.peers[j],index=c.offset+j,key=protocol.deriveMediaKey(source.seed)
  const p={...source,gate:Gate?new Gate():null,publishCamera:source.camera,index,key,seq:1,audio:0,camera:0,bytes:0,lastAudio:0,seenMarker:-1,hello:false,probeSent:0,audioSent:0,cameraFramesSent:0,decoder:(j===0&&index!==0)||index===1||index===c.users-1?new Opus(48000,1,Opus.Application.VOIP):null}
  const receive=packet=>{
   if(packet.subarray(0,9).toString()==='HELLO_ACK'){p.hello=true;return}
   const decoded=protocol.decryptPacket(key,packet);if(!decoded)return
   const now=Date.now();if(now<c.measure||now>=c.stop)return
   p.bytes+=packet.length
   if(decoded.kind===protocol.KIND_PROBE_ACK){const probe=protocol.decodeProbeAck(decoded.payload);if(probe)rtts.push(((now>>>0)-probe.clientMs)>>>0)}
   if(decoded.kind===6){p.camera++;return}
   if(decoded.kind!==protocol.KIND_OPUS2&&decoded.kind!==protocol.KIND_MIX3&&decoded.kind!==protocol.KIND_PCM)return
   p.audio++;if(p.lastAudio)gaps.push(now-p.lastAudio);p.lastAudio=now
   if(p.decoder){
    const shared=decoded.kind===protocol.KIND_MIX3?protocol.decodeMix3(decoded.payload):null
    const opus=shared || (decoded.kind===protocol.KIND_OPUS2?protocol.decodeOpus2(decoded.payload):null)
    if(shared&&p.mixEpoch!==shared.epoch){
     p.decoder.delete();p.decoder=new Opus(48000,1,Opus.Application.VOIP);p.mixEpoch=shared.epoch
     for(const old of shared.frames.slice(1).reverse())p.decoder.decode(old.data)
    }
    const pcm=opus?p.decoder.decode(opus.frames[0].data):decoded.payload
    if(pcm.length!==1920)return
    const magnitude=power(pcm)
    if(magnitude>1000){
     const marker=Math.floor((now-c.start)/1500)
     if(p.seenMarker!==marker){const delay=now-(c.start+marker*1500);if(delay>=0&&delay<1000){latencies.push(delay);p.seenMarker=marker}}
    }
   }
  }
  const transport=c.transport==='mixed'?['udp','tcp','ws'][index%3]:c.transport
  if(transport==='udp'){
   const socket=dgram.createSocket({type:'udp4',recvBufferSize:4<<20});await new Promise(r=>socket.bind(0,'0.0.0.0',r));socket.on('message',receive)
   p.send=data=>socket.send(data,c.port,mediaHost);p.close=()=>socket.close()
  }else if(transport==='tcp'){
   const socket=net.connect(c.port,mediaHost);socket.setNoDelay(true);await new Promise((r,reject)=>{socket.once('connect',r);socket.once('error',reject)})
   let buffer=Buffer.alloc(0)
   socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const n=buffer.readUInt32BE(0);if(buffer.length<4+n)break;receive(buffer.subarray(4,n+4));buffer=buffer.subarray(n+4)}})
   p.send=data=>{const out=Buffer.alloc(4+data.length);out.writeUInt32BE(data.length);data.copy(out,4);socket.write(out)};p.close=()=>socket.destroy()
  }else{
   const socket=new WebSocket(c.api.replace(/^http/,'ws'));await new Promise((r,reject)=>{socket.once('open',r);socket.once('error',reject)})
   socket.on('message',data=>receive(Buffer.from(data)));p.send=data=>socket.send(data);p.close=()=>socket.terminate()
  }
  p.send(Buffer.from(`HELLO2 ${source.token} ${c.clientCaps || "opus2 camera1"}`));peers.push(p)
 }
 await sleep(Math.max(0,c.start-Date.now()))
 const image=new Uint8Array(c.cameraBytes||10000).fill(83);image.set([255,216]);image.set([255,217],image.length-2)
 let next=c.start,probeAt=c.start,cameraAt=c.start,helloAt=c.start+10000
 function send(p,payload,kind){p.send(protocol.encryptPacket(p.key,p.seq++,Date.now(),p.room,payload,kind))}
 while(Date.now()<c.stop){
  const now=Date.now()
  if(now-next>20){const missed=Math.floor((now-next)/20);if(now>=c.measure)skipped+=missed;frame+=missed;next+=missed*20}
  for(const p of peers){
   if(!p.hello)p.send(Buffer.from(`HELLO2 ${p.token} ${c.clientCaps || "opus2 camera1"}`))
   if(p.active||c.openMicSilent){
    const bank=!p.active?9:p.index===0?0:1+p.index%8
    const rms=bank===9||(bank===0&&frame%75>=5)?0:0.02
    if(!p.gate||p.gate.admitRms(rms,now)){
     if(now>=c.measure)p.audioSent++
     send(p,protocol.encodeOpus2(frame,frame===0?1:0,[frames[bank][frame%75]]),protocol.KIND_OPUS2)
    }
   }
   if(now>=probeAt){if(now>=c.measure)p.probeSent++;send(p,protocol.encodeProbe(now,{lossPermille:0,jitterMs:0,bufferMs:60}),protocol.KIND_PROBE)}
  }
  if(now>=helloAt){for(const p of peers)p.send(Buffer.from(`HELLO2 ${p.token} ${c.clientCaps || "opus2 camera1"}`));helloAt=now+10000}
  if(now>=cameraAt){
   for(const p of peers)if(p.publishCamera){if(now>=c.measure)p.cameraFramesSent++;for(const packet of fragmentCamera(image,p.index+1,cameraFrame,now))send(p,Buffer.from(packet),6)}
   cameraFrame++;cameraAt+=1000/30
  }
  if(now>=probeAt)probeAt+=1000
  frame++;next+=20;await sleep(Math.max(0,next-Date.now()))
 }
 await sleep(100)
 for(const p of peers){p.close();p.decoder?.delete()}
 parentPort.postMessage({peers:peers.map(p=>({index:p.index,expected:p.expected,probeSent:p.probeSent,audioSent:p.audioSent,cameraFramesSent:p.cameraFramesSent,audio:p.audio,camera:p.camera,bytes:p.bytes,hello:p.hello})),probeRtt:rtts,gaps,markerLatencies:latencies,skippedTicks:skipped,generatorLoopP99Ms:loop.percentile(99)/1e6})
 process.exit(0)
}
