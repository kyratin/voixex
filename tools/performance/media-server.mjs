/** Isolated harness around the unmodified production media worker. Never expose publicly. */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
const root = process.env.BACKEND_ROOT || '/app'
const media = await import(pathToFileURL(`${root}/dist/media.js`))
const { makeMediaToken } = await import(pathToFileURL(`${root}/dist/token.js`))
const { WebSocketServer } = await import(pathToFileURL(`${root}/node_modules/ws/wrapper.mjs`))
const stats = [], resources = [], errors = []
let ready = false, members = [], epoch = Date.now(), lastCpu = process.cpuUsage(), lastAt = performance.now()
const lag = monitorEventLoopDelay({ resolution: 5 }); lag.enable()
const logger = { info(obj, message) { if (message?.includes('server listening')) ready = true; if (message === 'media network stats snapshot') stats.push({ at: Date.now(), ...obj }) }, warn(obj,msg) { errors.push({at:Date.now(),...obj,msg}) }, error(obj,msg) { errors.push({at:Date.now(),error:String(obj.err),msg}) }, debug() {} }
media.createMediaServer(logger)
setInterval(() => {
 const now = performance.now(), cpu = process.cpuUsage(), used = (cpu.user-lastCpu.user+cpu.system-lastCpu.system)/1000
 resources.push({ cgroup: (()=>{try{return readFileSync("/sys/fs/cgroup/cpu.stat","utf8")}catch{return null}})(), at:Date.now(), cpuPct:used/(now-lastAt)*100, rssMiB:process.memoryUsage().rss/1048576, mainLoopP99Ms:lag.percentile(99)/1e6 })
 lastCpu=cpu;lastAt=now;lag.reset()
},1000).unref()
const server = http.createServer(async (req,res) => {
 res.setHeader('Content-Type','application/json')
 if(req.url==='/health'){res.end(JSON.stringify({ready}));return}
 if(req.url==='/metrics'){res.end(JSON.stringify({epoch,stats,resources,errors}));return}
 if(req.url==='/setup' && req.method==='POST'){
  const chunks=[];for await(const chunk of req)chunks.push(chunk)
  const c=JSON.parse(Buffer.concat(chunks)); for(const member of members)media.removeMember(member.id); members=[];stats.length=0;resources.length=0;errors.length=0;epoch=Date.now()
  for(let i=0;i<c.users;i++){
   const id=`10000000-0000-4000-8000-${String(i).padStart(12,"0")}`,room=`20000000-0000-4000-8000-${String(i%c.rooms).padStart(12,"0")}`,seed=randomBytes(32).toString('base64')
   media.setMemberRoom(id,room);media.setMemberCameraAllowed(id,true)
   const active=i<c.speakers
   media.setMemberFlags(id,!active&&!c.openMicSilent,false)
   members.push({id,room,seed,active,camera:i<(c.cameras||0),token:makeMediaToken({serverId:'benchmark-only',clientId:id,mediaSeed:seed},process.env.TOKEN_SECRET)})
  }
  res.end(JSON.stringify(members));return
 }
 res.statusCode=404;res.end('{}')
})
let conn=0
const wss=new WebSocketServer({server,maxPayload:65536})
wss.on('connection',socket=>{
 const id=`bench-ws-${conn++}`
 const handler=media.attachMediaSocket(id,id,{send:data=>socket.send(data),close:()=>socket.close(),bufferedAmount:()=>socket.bufferedAmount})
 socket.on('message',data=>handler.data(data));socket.on('close',()=>handler.closed())
})
server.listen(Number(process.env.BENCH_PORT||18080),'0.0.0.0',()=>console.log('BENCH_HARNESS_READY'))
