/** Component benchmark: codec complexity and decode cost, not a capacity promise. */
import { OpusCodec } from '/app/dist/media/opus-codec.js'
const frames=[]
let random=1234567
for(let frame=0;frame<100;frame++){
 const pcm=Buffer.alloc(1920)
 for(let i=0;i<960;i++){
  random=(Math.imul(random,1664525)+1013904223)>>>0
  const time=(frame*960+i)/48000
  const envelope=.4+.6*Math.sin(2*Math.PI*3*time)**2
  const signal=envelope*(4000*Math.sin(2*Math.PI*130*time)+2200*Math.sin(2*Math.PI*700*time)+1300*Math.sin(2*Math.PI*1200*time))+(random/4294967296-.5)*300
  pcm.writeInt16LE(Math.round(signal),i*2)
 }
 frames.push(pcm)
}
const results=[]
for(const complexity of [3,5,8,10]){
 const encoder=new OpusCodec(48000,1,OpusCodec.Application.VOIP)
 encoder.setBitrate(40000);encoder.encoderCTL(4010,complexity);encoder.encoderCTL(4024,3001)
 for(let i=0;i<150;i++)encoder.encode(frames[i%frames.length],960)
 const samples=[],packets=[];let cpu=process.cpuUsage(),start=performance.now()
 for(let i=0;i<1500;i++){const at=performance.now();packets.push(encoder.encode(frames[i%frames.length],960));samples.push(performance.now()-at)}
 const elapsed=performance.now()-start,used=process.cpuUsage(cpu)
 encoder.delete();samples.sort((a,b)=>a-b)
 const decoder=new OpusCodec(48000,1,OpusCodec.Application.VOIP);start=performance.now()
 for(const packet of packets)decoder.decode(packet)
 results.push({complexity,encodeAvgMs:elapsed/1500,encodeP99Ms:samples[Math.floor(samples.length*.99)],encodeCpuMs:(used.user+used.system)/1000,decodeAvgMs:(performance.now()-start)/1500,packetBytesAvg:packets.reduce((s,p)=>s+p.length,0)/packets.length})
 decoder.delete()
}
console.log(JSON.stringify(results,null,2))
