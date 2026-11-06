import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RoomMix } from '../src/media/room-mix.js'
import { SharedMixes } from '../src/media/shared-mix.js'
import { OpusCodec } from '../src/media/opus-codec.js'
import { decodeMix3, encodeMix3 } from '../src/media/protocol.js'
test('shared room sum preserves self exclusion and sparse gain before clipping',()=>{
 const sources=Array.from({length:12},(_,n)=>({clientId:String(n),frame:Int16Array.from({length:960},(_,i)=>Math.round(Math.sin(i*(n+1)*.01)*2200))}))
 const room=new RoomMix(sources)
 for(let listener=0;listener<14;listener++){
  const gains=new Map([['1',0],['3',2],['8',.35],['absent',0]])
  const actual=room.forListener(String(listener),gains)!
  const expected=new Float32Array(960)
  for(const source of sources)if(source.clientId!==String(listener))for(let i=0;i<960;i++)expected[i]+=source.frame[i]*(gains.get(source.clientId)??1)
  assert.ok(actual.every((sample,i)=>Math.abs(sample-expected[i])<=.01))
 }
 assert.equal(new RoomMix([sources[0]]).forListener('0'),null)
})
test('identical mixes encode once; epochs can be joined with decoder pre-roll',()=>{
 const pool=new SharedMixes(),decoder=new OpusCodec(48000,1,OpusCodec.Application.VOIP)
 try{
  let previous=0
  for(let tick=1;tick<80;tick++){
   const pcm=Int16Array.from({length:960},(_,i)=>Math.round(5000*Math.sin((tick*960+i)*2*Math.PI*500/48000)))
   const first=pool.encode('base',pcm,tick,tick*20,40000,0)!
   const second=pool.encode('base',pcm,tick,tick*20,40000,0)!
   assert.equal(first,second);assert.equal(first.frames[0],second.frames[0])
   if(tick>5&&tick%9===0){
    const packet=decodeMix3(encodeMix3(first.epoch,tick,first.flags,first.frames))!
    assert.equal(packet.frames.length,5)
    for(const frame of packet.frames.slice(1).reverse())decoder.decode(frame.data)
    const result=decoder.decode(packet.frames[0].data)
    let power=0;for(let i=0;i<960;i++)power+=(result.readInt16LE(i*2)/32768)**2
    assert.ok(Math.sqrt(power/960)>.05)
   }
   previous=first.epoch
  }
  const other=pool.encode('exclude-speaker',new Int16Array(960),80,1600,40000,0)!
  assert.notEqual(other.epoch,previous)
  pool.sweep(9000)
 }finally{pool.clear();decoder.delete()}
})
