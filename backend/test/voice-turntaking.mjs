// Production server + actual client engines; capture clocks start separately for each participant.
// Run after building backend and voice-client, with CAMERA_CLIENT_ROOT pointing at the client repo.
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import {randomBytes} from 'node:crypto'
import {WebSocketServer} from 'ws'

assert.ok(process.env.CAMERA_CLIENT_ROOT, 'CAMERA_CLIENT_ROOT is required')
const reservation=net.createServer()
await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve))
const port=reservation.address().port
await new Promise(resolve=>reservation.close(resolve))
process.env.UDP_HOST='127.0.0.1'
process.env.UDP_PORT=String(port)
process.env.TOKEN_SECRET='turntaking-regression-only'
const media=await import('../dist/media/core.js')
const {makeMediaToken}=await import('../dist/token.js')
const {VoiceEngine}=await import(`${process.env.CAMERA_CLIENT_ROOT}/voice-client/dist/index.js`)
const warnings=[]
media.startMedia({info(){},debug(){},warn(obj,msg){warnings.push({obj,msg})}}, {})
const server=http.createServer(),wss=new WebSocketServer({server})
let connection=0
wss.on('connection',socket=>{
  const id=`turntaking-ws-${connection++}`
  media.wsOpen(id,id,data=>socket.send(data),()=>socket.close())
  socket.on('message',data=>media.wsData(id,Buffer.from(data)))
  socket.on('close',()=>media.wsClose(id))
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const apiBase=`http://127.0.0.1:${server.address().port}`
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),frequencies=[400,700,1000]
const peers=[],engines=[]
let active=[true,true,true],metrics,run=0
function resetMetrics(){metrics=Array.from({length:3},()=>({frames:0,heard:[0,0,0]}))}
function power(pcm,hz){
  let re=0,im=0
  for(let i=0;i<960;i++){
    const angle=2*Math.PI*hz*i/48000,sample=pcm.readInt16LE(i*2)
    re+=sample*Math.cos(angle);im+=sample*Math.sin(angle)
  }
  return Math.hypot(re,im)/960
}
resetMetrics()
async function join(index,transport){
  const id=`turntaking-${run}-${index}`,seed=randomBytes(32).toString('base64')
  const mediaToken=makeMediaToken({serverId:'turntaking-server',clientId:id,mediaSeed:seed},process.env.TOKEN_SECRET)
  media.setMemberRoom(id,`turntaking-room-${run}`)
  const engine=new VoiceEngine({host:'127.0.0.1',port,apiBase,mediaToken,mediaSeed:seed,transport})
  engines.push(engine)
  engine.setOnPcm16Frame(frame=>{
    if(frame.length!==1920)return
    const metric=metrics[index];metric.frames++
    frequencies.forEach((frequency,source)=>{if(power(frame,frequency)>600)metric.heard[source]++})
  })
  await engine.connect();engine.joinRoom(`turntaking-room-${run}`)
  // Each capture loop has its own first tick and counter, including after reconnect.
  let frameNo=0
  const timer=setInterval(()=>{
    const pcm=Buffer.alloc(1920)
    if(active[index])for(let i=0;i<960;i++)pcm.writeInt16LE(Math.round(6500*Math.sin((frameNo*960+i)*2*Math.PI*frequencies[index]/48000)),i*2)
    engine.sendPcm16Frame(pcm);frameNo++
  },20)
  peers[index]={id,engine,timer,transport}
}
function leave(index){
  const peer=peers[index]
  if(!peer)return
  clearInterval(peer.timer);peer.engine.close();media.removeMember(peer.id);peers[index]=null
}
async function check(label,sources,listeners=[0,1,2]){
  active=active.map((_,index)=>sources.includes(index))
  await sleep(450);resetMetrics();await sleep(1000)
  for(const listener of listeners){
    for(const source of sources)if(source!==listener)assert.ok(metrics[listener].heard[source]>30,`${label}: listener ${listener} lost source ${source}: ${JSON.stringify(metrics)}`)
    assert.ok(metrics[listener].heard[listener]<8,`${label}: self echo: ${JSON.stringify(metrics)}`)
  }
  console.log(`PASS ${label}: ${JSON.stringify(metrics)}`)
}
let success=false
try{
  const combinations=process.env.TURNTAKING_TRANSPORTS
    ? [process.env.TURNTAKING_TRANSPORTS.split(',')]
    : [['udp','tcp','ws'],['ws','udp','tcp']]
  for(const transports of combinations){
    assert.equal(transports.length,3)
    run++;active=[true,true,true]
    await join(0,transports[0]);await sleep(660)
    await join(1,transports[1]);await sleep(940)
    await join(2,transports[2])
    for(const sources of [[0,1,2],[0],[1],[2],[0,1],[1,2],[0,2],[0,1,2]]){
      await check(`${transports.join('/')} sources ${sources.join('+')}`,sources)
    }
    if(peers[0].engine.demandSupported){
      for(const peer of peers)peer.engine.setMediaState({voice:false})
      await sleep(500);resetMetrics();await sleep(350)
      assert.ok(metrics.every(metric=>metric.frames===0),'all SFU receivers must stop legacy playback')
      peers[2].engine.setMediaState({voice:true})
      await check('one legacy receiver hears both other publishers after demand resumes',[0,1,2],[2])
      assert.equal(metrics[0].frames,0);assert.equal(metrics[1].frames,0)
      for(const peer of peers)peer.engine.setMediaState({voice:true})
      await check('legacy fallback restores all three independent publishers',[0,1,2])
    }else console.log('INFO old server: demand negotiation unavailable; compatibility voice verified')
    active=[true,true,false];leave(2)
    await check('third participant leaves; original two remain audible',[0,1],[0,1])
    active=[true,true,true]
    const returnTransport=transports[2]==='udp'?'ws':'udp'
    await join(2,returnTransport)
    await check(`third participant returns using ${returnTransport}`,[0,1,2])
    for(let index=0;index<3;index++)leave(index)
  }
  assert.equal(warnings.filter(row=>/encode failed|worker crashed/.test(row.msg??'')).length,0)
  console.log('PASS independent capture clocks, turn-taking, demand transitions, leave/return and mixed transports')
  success=true
}catch(error){console.error(error)}finally{
  for(let index=0;index<3;index++)leave(index)
  for(const engine of engines)engine.close()
  for(const socket of wss.clients)socket.terminate()
  server.close();setTimeout(()=>process.exit(success?0:1),50)
}
