// Real WebVoiceEngine microphone -> production media worker -> desktop Opus decoders.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { build } from 'esbuild'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const frontend=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(frontend,'..')
const serverRoot=process.env.CAMERA_SERVER_ROOT||resolve(root,'../voixex-camera-server')
const output=mkdtempSync(join(tmpdir(),'voixex-uplink-'))
await build({stdin:{contents:`export {WebVoiceEngine} from './lib/web-voice/engine'`,resolveDir:frontend},bundle:true,format:'esm',outfile:join(output,'bundle.js')})
// Reuse the mixed UDP/TCP/WS fixture, adding independent decoded-audio counters.
let relaySource=readFileSync(resolve(serverRoot,'backend/test/camera-transports.mjs'),'utf8')
relaySource=relaySource.replace('import { WebSocketServer } from "ws"',`import {createRequire} from 'node:module'; const {WebSocketServer}=createRequire(${JSON.stringify(resolve(serverRoot,'backend/package.json'))})('ws')`)
relaySource=relaySource.replaceAll('import("../dist/',`import("${serverRoot}/backend/dist/`)
relaySource=relaySource.split('\n').filter(line=>!line.startsWith('assert.equal(readFileSync(new URL(')).join('\n')
relaySource=relaySource.replace('let browserPeers','const heard={}\nlet browserPeers')
relaySource=relaySource.replace('  if (request.url === "/test/frames") {',`  if(request.url==='/test/uplink'){response.end(JSON.stringify(heard));return}
  if(request.url.startsWith('/test/demand/')){for(const peer of browserPeers)peer.engine.setMediaState({voice:request.url.endsWith('true')});response.end('{}');return}
  if(request.url==='/test/leave'){browserPeers[2].engine.close();media.removeMember(browserPeers[2].id);response.end('{}');return}
  if(request.url==='/test/join'){browserPeers[2]=await client('peer-ws','ws');response.end('{}');return}
  if (request.url === "/test/frames") {`)
relaySource=relaySource.replace('  const frames = [], assembler = new CameraAssembler()',`  heard[id]={frames:0,tone:0}
  engine.setOnPcm16Frame(pcm=>{let re=0,im=0;for(let i=0;i<960;i++){const angle=2*Math.PI*500*i/48000;re+=pcm.readInt16LE(i*2)*Math.cos(angle);im+=pcm.readInt16LE(i*2)*Math.sin(angle)}heard[id].frames++;if(Math.hypot(re,im)/960>500)heard[id].tone++})
  const frames = [], assembler = new CameraAssembler()`)
writeFileSync(join(output,'relay.mjs'),relaySource)
const relay=spawn(process.execPath,[join(output,'relay.mjs')],{env:{...process.env,CAMERA_BROWSER:'1',CAMERA_CLIENT_ROOT:root},stdio:['ignore','pipe','pipe']})
relay.stderr.on('data',data=>process.stderr.write(data))
const relayUrl=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(new Error('Relay did not start')),15000);relay.stdout.on('data',data=>{log+=data;const match=log.match(/BROWSER_RELAY_READY (http:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1])}});relay.on('exit',code=>{clearTimeout(timer);reject(new Error(`Relay exited ${code}`))})})
const server=http.createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(readFileSync(join(output,'bundle.js')))}else res.end('<html><body></body></html>')})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({...(process.env.CAMERA_CHROME?{executablePath:process.env.CAMERA_CHROME}:{}),headless:true})
try{
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.evaluate(async relayUrl=>{
  const{WebVoiceEngine}=await import('/bundle.js');window.engine=new WebVoiceEngine();await window.engine.connect(await(await fetch(`${relayUrl}/test/token`)).json());window.engine.joinRoom('room-a');window.speaking=true;let tick=0
  window.captureTimer=setInterval(()=>{const pcm=new Int16Array(960);if(window.speaking)for(let i=0;i<960;i++)pcm[i]=Math.round(6500*Math.sin(2*Math.PI*500*(tick*960+i)/48000));tick++;window.engine.sendPcm16(pcm)},20)
 },relayUrl)
 async function audible(label,listeners=['peer-tcp','peer-ws']){
  await page.waitForTimeout(250);const before=await(await fetch(`${relayUrl}/test/uplink`)).json();await page.waitForTimeout(1000);const after=await(await fetch(`${relayUrl}/test/uplink`)).json()
  for(const id of listeners)assert.ok(after[id].tone-before[id].tone>=25,`${label}: ${id} lost browser mic: ${JSON.stringify({before,after,stats:await page.evaluate(()=>window.engine.getStats())})}`)
  console.log(`PASS ${label}: browser microphone decoded and audible to desktop listeners`)
 }
 await audible('three mixed participants')
 await page.evaluate(()=>window.speaking=false);await page.waitForTimeout(700);await page.evaluate(()=>window.speaking=true);await audible('speech resumes after digital silence')
 await page.evaluate(()=>window.engine.setMute(true));await page.waitForTimeout(350);await page.evaluate(()=>window.engine.setMute(false));await audible('mute and unmute preserve encoder correlation')
 await fetch(`${relayUrl}/test/demand/false`);await page.waitForFunction(()=>!window.engine.getMediaDemand().voice);await page.waitForTimeout(400)
 await fetch(`${relayUrl}/test/demand/true`);await page.waitForFunction(()=>window.engine.getMediaDemand().voice);await audible('SFU demand pause returns to compatible voice')
 await fetch(`${relayUrl}/test/leave`);await audible('third participant leaves',['peer-tcp'])
 await fetch(`${relayUrl}/test/join`);await audible('third participant rejoins')
 assert.equal(await page.evaluate(()=>window.engine.getStats().uplinkCodec),'opus');assert.equal(await page.evaluate(()=>window.engine.getStats().uplinkFallbacks),0)
 await page.evaluate(()=>{clearInterval(window.captureTimer);window.engine.close()})
}finally{await browser.close();relay.kill('SIGTERM');server.close();rmSync(output,{recursive:true,force:true})}
