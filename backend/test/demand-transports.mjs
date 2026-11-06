// Run separately: production media owns its UDP/TCP sockets and recurring clock.
import assert from 'node:assert/strict'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
const reservation = net.createServer()
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
process.env.UDP_HOST = '127.0.0.1'; process.env.UDP_PORT = String(port)
process.env.TOKEN_SECRET = 'demand-regression-only'
const media = await import('../dist/media/core.js')
const { makeMediaToken } = await import('../dist/token.js')
const { deriveMediaKey, encryptPacket, decryptPacket, KIND_PCM, KIND_OPUS2, KIND_MIX3, KIND_MEDIA_STATE } = await import('../dist/media/protocol.js')
media.startMedia({info(){},warn(){},debug(){}}, {})
const peers = []
function peer(id, caps = 'opus2 camera1 mix3 demand2', hello = 'HELLO2') {
  const seed = randomBytes(32).toString('base64'), key = deriveMediaKey(seed), packets = []
  const token = makeMediaToken({serverId:'demand-server',clientId:id,mediaSeed:seed},process.env.TOKEN_SECRET)
  media.setMemberRoom(id, 'demand-room'); media.setMemberCameraAllowed(id, true)
  media.wsOpen(id,id,packet=>{const decoded=decryptPacket(key,Buffer.from(packet));if(decoded)packets.push(decoded)},()=>{})
  media.wsData(id,Buffer.from(`${hello} ${token} ${caps}`.trim()))
  let seq = 1
  const result = {id,packets,session:media.__test.sessions.get(id),send(kind,payload){media.wsData(id,encryptPacket(key,seq++,Date.now(),'demand-room',payload,kind))},state(flags){this.send(KIND_MEDIA_STATE,Buffer.from([1,flags]));media.__test.mixTick()}}
  peers.push(result);return result
}
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms))
let success = false
try {
  const a=peer('publisher'),b=peer('receiver')
  a.state(16) // No legacy playback interest; camera is already published to SFU.
  b.state(2|4) // Wants cameras, can receive SFU camera, no legacy voice.
  assert.equal(a.session.voiceNeeded,false)
  assert.equal(a.session.cameraNeeded,false)
  const before=a.session.stats.rxAudioFrames
  a.send(KIND_PCM,Buffer.alloc(1920,15))
  assert.equal(a.session.stats.rxAudioFrames,before,'no unnecessary voice enters decoder queues')
  b.state(1|2) // Lost SFU / compatibility receiver.
  assert.equal(a.session.voiceNeeded,true)
  assert.equal(a.session.cameraNeeded,true)
  a.send(KIND_PCM,Buffer.alloc(1920,15))
  assert.equal(a.session.stats.rxAudioFrames,before+1)
  console.log('PASS demand stops unneeded audio/JPEG and promptly restores compatibility fallback')

  b.state(0)
  const old=peer('old-opus2','opus2 camera1')
  media.__test.mixTick()
  assert.equal(a.session.voiceNeeded,true);assert.equal(a.session.cameraNeeded,true)
  assert.equal(old.session.caps.mix3,false);assert.equal(old.session.caps.demand2,false)
  media.setMemberRoom(old.id,null);media.__test.mixTick()
  assert.equal(a.session.voiceNeeded,false);assert.equal(a.session.cameraNeeded,false)
  b.session.demand.until=Date.now()-1;media.__test.mixTick()
  assert.equal(a.session.voiceNeeded,true);assert.equal(a.session.cameraNeeded,true)
  console.log('PASS old peers conservatively keep compatibility streams; expired leases fail open')

  b.state(1|2);media.setMemberRoom(old.id,'demand-room')
  const legacy=peer('legacy-pcm','','HELLO')
  for(let frame=0;frame<35;frame++){
    const pcm=Buffer.alloc(1920)
    for(let i=0;i<960;i++)pcm.writeInt16LE(Math.round(6000*Math.sin((frame*960+i)*Math.PI*2*500/48000)),i*2)
    a.send(KIND_PCM,pcm)
    await delay(20)
  }
  assert.ok(b.packets.filter(p=>p.kind===KIND_MIX3).length>15)
  assert.ok(old.packets.filter(p=>p.kind===KIND_OPUS2).length>15)
  assert.ok(legacy.packets.filter(p=>p.kind===KIND_PCM&&p.payload.length>0).length>15)
  assert.equal(old.packets.some(p=>p.kind===KIND_MIX3||p.kind===KIND_MEDIA_STATE),false)
  assert.equal(legacy.packets.some(p=>p.kind===KIND_MIX3||p.kind===KIND_MEDIA_STATE),false)
  console.log('PASS new mix3, old Opus2 and original PCM receivers coexist in the same room')
  success=true
} catch(error) { console.error(error) }
finally { for(const peer of peers){media.wsClose(peer.id);media.removeMember(peer.id)};setTimeout(()=>process.exit(success?0:1),30) }
