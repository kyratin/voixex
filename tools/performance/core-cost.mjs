/** Offline production-core CPU calibration. No production rooms, database or traffic. */
import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { OpusCodec } from '/app/dist/media/opus-codec.js'
import * as protocol from '/app/dist/media/protocol.js'
import { makeMediaToken } from '/app/dist/token.js'
import * as media from '/app/dist/media/core.js'
const {fragmentCamera}=await import('/app/dist/media/camera-protocol.js')
const encoder=new OpusCodec(48000,1,OpusCodec.Application.VOIP);encoder.setBitrate(32000)
const bank=[]
for(let frame=0;frame<100;frame++){
 const pcm=Buffer.alloc(1920)
 for(let i=0;i<960;i++){const t=(frame*960+i)/48000;pcm.writeInt16LE(Math.round((.4+.6*Math.sin(2*Math.PI*3*t)**2)*(3000*Math.sin(2*Math.PI*130*t)+1500*Math.sin(2*Math.PI*700*t)+700*Math.sin(2*Math.PI*1200*t))),i*2)}
 bank.push(encoder.encode(pcm,960))
}encoder.delete()
let now=1000000;Date.now=()=>now
const errors=[]
media.startMedia({info(){},debug(){},warn(obj,msg){errors.push({obj,msg})}},{})
const cases=JSON.parse(process.env.CASES||"[[10,4,0],[25,4,0],[50,4,0],[100,4,0],[25,25,0],[50,50,0],[100,100,0],[12,4,3],[12,4,12]]")
const results=[]
for(const [users,speakers,cameras]of cases){
 const peers=[];let bytes=0,packets=0
 for(let i=0;i<users;i++){
  const id=`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`,room='20000000-0000-4000-8000-000000000000',seed=randomBytes(32).toString('base64')
  const token=makeMediaToken({serverId:'isolated-benchmark',clientId:id,mediaSeed:seed},process.env.TOKEN_SECRET)
  media.setMemberRoom(id,room);media.setMemberFlags(id,i>=speakers,false);media.setMemberCameraAllowed(id,true)
  media.wsOpen(id,id,p=>{bytes+=p.length;packets++},()=>{})
  media.wsData(id,Buffer.from(`HELLO2 ${token} ${process.env.CLIENT_CAPS || "opus2 camera1"}`));peers.push({id,room,key:protocol.deriveMediaKey(seed),seq:1})
 }
 const image=new Uint8Array(10000).fill(41);image.set([255,216]);image.set([255,217],9998)
 const tick=(frame)=>{
  now+=20
  for(let i=0;i<speakers;i++){const p=peers[i],payload=protocol.encodeOpus2(frame,frame===0?1:0,[bank[(frame+i*7)%100]]);media.wsData(p.id,protocol.encryptPacket(p.key,p.seq++,now,p.room,payload,protocol.KIND_OPUS2))}
  if(frame%5<3)for(let i=0;i<cameras;i++){const p=peers[i];for(const payload of fragmentCamera(image,i+1,frame,now))media.wsData(p.id,protocol.encryptPacket(p.key,p.seq++,now,p.room,Buffer.from(payload),6))}
  media.__test.mixTick()
  media.__test.drainQueues?.()
 }
 const warm=Number(process.env.WARMUP_FRAMES||75)
 for(let i=0;i<warm;i++)tick(i)
 const count=Number(process.env.FRAMES||150),samples=[],start=performance.now(),cpu=process.cpuUsage();bytes=0;packets=0
 for(let i=warm;i<count+warm;i++){const at=performance.now();tick(i);samples.push(performance.now()-at)}
 const used=process.cpuUsage(cpu),wall=performance.now()-start,cpuMs=(used.user+used.system)/1000;samples.sort((a,b)=>a-b)
 results.push({users,speakers,cameras,frames:count,cpuMsPerTick:cpuMs/count,cpuCoresRequired:cpuMs/(count*20),wallMsPerTick:wall/count,tickWallP99Ms:samples[Math.floor(count*.99)],egressMbps:bytes*8/(count*.02)/1e6,packetsPerSecond:packets/(count*.02)})
 for(const p of peers){media.wsClose(p.id);media.removeMember(p.id)}
}
console.log(JSON.stringify({node:process.version,arch:process.arch,cpuModel:os.cpus()[0].model,results,errors}))
process.exit(errors.length?1:0)
