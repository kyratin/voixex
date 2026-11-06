import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MediaSendQueue } from '../src/media-send-queue.js'
test('speech/control outrank camera, stale speech expires, newest camera replaces old frame',()=>{
 let now=1000,ready=false
 const queue=new MediaSendQueue(()=>now),sent:string[]=[],work=(id:string)=>({bytes:1000,send:()=>{if(!ready)return false;sent.push(id);return true}})
 try {
  queue.pushVideo('camera',[work('old-1'),work('old-2')])
  queue.push(work('stale-audio'))
  queue.pushVideo('camera',[work('new-1'),work('new-2')])
  now+=90;queue.push(work('fresh-audio'));queue.push(work('control'),true)
  ready=true;queue.drain()
  assert.deepEqual(sent,['control','fresh-audio','new-1','new-2'])
  assert.equal(queue.stats.expiredAudio,1);assert.equal(queue.stats.droppedVideo,1)
 }finally{queue.close()}
})
test('blocked queues retain at most three audio frames and no video past its deadline',()=>{
 let now=0,ready=false
 const queue=new MediaSendQueue(()=>now),sent:number[]=[]
 try {
  for(let id=0;id<100;id++)queue.push({bytes:150,send:()=>{if(!ready)return false;sent.push(id);return true}})
  queue.pushVideo('x',[{bytes:900,send:()=>{throw new Error('expired video must not send')}}])
  now=110;ready=true;queue.drain()
  assert.deepEqual(sent,[]);assert.equal(queue.stats.droppedAudio,97)
 }finally{queue.close()}
})
