import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import dgram from 'node:dgram'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
const clientRoot = process.env.CAMERA_CLIENT_ROOT
assert.ok(clientRoot, 'CAMERA_CLIENT_ROOT must point to the matching built client')
assert.equal(readFileSync(new URL('../dist/media/opus-codec.js', import.meta.url), 'utf8'), readFileSync(`${clientRoot}/voice-client/dist/opus-codec.js`, 'utf8'))
const reservation = net.createServer()
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
process.env.UDP_HOST = '127.0.0.1'; process.env.UDP_PORT = String(port); process.env.TOKEN_SECRET = 'voice-test-local-only'
const media = await import('../dist/media/core.js')
const { makeMediaToken } = await import('../dist/token.js')
const { VoiceEngine } = await import(`${clientRoot}/voice-client/dist/index.js`)
const { fragmentCamera } = await import('../dist/media/camera-protocol.js')
const server = http.createServer(), wss = new WebSocketServer({ server })
let conn = 0
wss.on('connection', socket => {
  const id = `voice-test-${conn++}`
  media.wsOpen(id, id, data => socket.send(data), () => socket.close())
  socket.on('message', data => media.wsData(id, Buffer.from(data))); socket.on('close', () => media.wsClose(id))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const apiBase = `http://127.0.0.1:${server.address().port}`
const warnings = []
media.startMedia({ info() {}, debug() {}, warn(obj, msg) { warnings.push({obj,msg}) } }, {})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const peers = [], proxies = [], engines = []
let lossy = false, tick = 0, cameraFrame = 0
const frequencies = [400, 700, 1000]
const metrics = new Map()
function power(pcm, frequency) { let re=0, im=0; for(let i=0;i<960;i++){const x=pcm.readInt16LE(i*2), angle=2*Math.PI*frequency*i/48000;re+=x*Math.cos(angle);im+=x*Math.sin(angle)}return Math.hypot(re,im)/960 }
function measure(index, frame) {
  if(frame.length !== 1920)return
  const m=metrics.get(index);if(!m)return
  m.frames++
  for(let i=0;i<3;i++)if(power(frame,frequencies[i])>600)m.heard[i]++
}
async function proxy() {
  const socket=dgram.createSocket('udp4');proxies.push(socket)
  await new Promise(resolve=>socket.bind(0,'127.0.0.1',resolve))
  let endpoint, counter=0
  socket.on('message',(data,rinfo)=>{
    if(lossy&&data.length>40&&data[0]===0x56&&++counter%29===0)return
    if(rinfo.port===port){if(endpoint)socket.send(data,endpoint.port,endpoint.address)}
    else{endpoint=rinfo;socket.send(data,port,'127.0.0.1')}
  })
  return socket.address().port
}
async function join(index, transport) {
  const id=`voice-peer-${index}`, seed=randomBytes(32).toString('base64')
  const token=makeMediaToken({serverId:'voice-test-server',clientId:id,mediaSeed:seed},process.env.TOKEN_SECRET)
  media.setMemberRoom(id,'voice-test-room');media.setMemberCameraAllowed(id,true)
  const engine=new VoiceEngine({host:'127.0.0.1',port:transport==='udp'?await proxy():port,apiBase,mediaToken:token,mediaSeed:seed,transport})
  engines.push(engine);engine.setOnPcm16Frame(frame=>measure(index,frame))
  await engine.connect();engine.joinRoom('voice-test-room')
  return {id,engine,muted:false}
}
function resetMetrics(){for(let i=0;i<3;i++)metrics.set(i,{frames:0,heard:[0,0,0]})}
async function audible(label, sources=[0,1,2]){
  await delay(400);resetMetrics();await delay(1800)
  for(let listener=0;listener<3;listener++){
    const m=metrics.get(listener)
    assert.ok(m.frames>45,`${label}: listener ${listener} received only ${m.frames} PCM frames`)
    for(const source of sources)if(source!==listener)assert.ok(m.heard[source]>35,`${label}: listener ${listener} lost source ${source}: ${JSON.stringify(m)}`)
    assert.ok(m.heard[listener]<10,`${label}: listener must not hear itself`)
  }
  console.log(`PASS ${label}: all three listeners receive the other speakers' tones`)
}
let sendTimer, cameraTimer, success=false
try {
  for(const [index,transport]of ['udp','tcp','ws'].entries())peers.push(await join(index,transport))
  sendTimer=setInterval(()=>{
    for(let index=0;index<3;index++){
      const peer=peers[index];if(!peer||peer.muted)continue
      const pcm=Buffer.alloc(1920)
      for(let i=0;i<960;i++)pcm.writeInt16LE(Math.round(Math.sin((tick*960+i)*2*Math.PI*frequencies[index]/48000)*6500),i*2)
      peer.engine.sendPcm16Frame(pcm)
    }
    tick++
  },20)
  const image=new Uint8Array(9000).fill(33);image.set([255,216]);image.set([255,217],8998)
  cameraTimer=setInterval(()=>{for(const packet of fragmentCamera(image,800,cameraFrame++,Date.now()))peers[0]?.engine.sendCameraPacket(Buffer.from(packet))},33)
  await audible('UDP/TCP/WebSocket voice with concurrent camera traffic')
  lossy=true;await audible('packet loss recovers without corrupting Opus');lossy=false
  peers[1].muted=true;peers[1].engine.setMute(true);media.setMemberFlags(peers[1].id,true,false)
  await audible('muting one microphone preserves all other voice',[0,2])
  peers[1].muted=false;peers[1].engine.setMute(false);media.setMemberFlags(peers[1].id,false,false)
  for(const transport of ['tcp','ws','udp']){
    peers[2].engine.close();media.removeMember(peers[2].id);peers[2]=null
    await delay(100);peers[2]=await join(2,transport)
    await audible(`participant rejoin using ${transport}`)
  }
  assert.equal(warnings.filter(w=>/encode failed|worker crashed/.test(w.msg??'')).length,0)
  console.log('PASS sustained three-person audio, loss, mute and transport churn; no codec errors')
  success=true
}catch(error){console.error(error)}finally{
 clearInterval(sendTimer);clearInterval(cameraTimer)
 for(const engine of engines)engine.close()
 for(const socket of proxies)socket.close()
 for(const socket of wss.clients)socket.terminate()
 server.close();setTimeout(()=>process.exit(success?0:1),50)
}
