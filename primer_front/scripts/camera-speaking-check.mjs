/** Visible camera speaking indicators: real main stage and mini call components in Chromium. */
import { chromium } from 'playwright'
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = await mkdtemp(join(tmpdir(), 'voixex-camera-speaking-'))
let browser, server
try {
  const bundle = join(output, 'bundle.js')
  await build({entryPoints:[resolve(frontend,'test/camera-speaking-entry.tsx')],bundle:true,format:'esm',outfile:bundle})
  const cssDir = resolve(frontend, 'out/_next/static/css')
  const css = (await Promise.all((await readdir(cssDir)).filter(file=>file.endsWith('.css')).map(file=>readFile(join(cssDir,file),'utf8')))).join('\n')
  const js = await readFile(bundle)
  server = http.createServer((request,response)=>{
    if(request.url==='/bundle.js'){response.setHeader('Content-Type','text/javascript');response.end(js)}
    else if(request.url==='/style.css'){response.setHeader('Content-Type','text/css');response.end(css)}
    else response.end('<html class="dark"><head><link rel="stylesheet" href="/style.css"><style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body style="margin:0;background:#111218"></body></html>')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  browser=await chromium.launch({...(process.env.CAMERA_CHROME?{executablePath:process.env.CAMERA_CHROME}:{}),headless:true,args:['--autoplay-policy=no-user-gesture-required']})
  const page=await browser.newPage({viewport:{width:1300,height:1000},locale:'en-US'})
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.evaluate(async()=>{const module=await import('/bundle.js');window.fixture=module.mountCameraSpeakingHarness()})
  await page.waitForSelector('[data-mini-camera-grid] video')
  await page.waitForFunction(()=>[...document.querySelectorAll('video')].every(video=>video.videoWidth>0))
  const checkRing=async(id,on)=>{
    await page.waitForFunction(({id,on})=>['[data-main-speaking]','[data-mini-speaking]'].every(scope=>{
      const tile=document.querySelector(`${scope} [data-participant-id="${id}"]`)
      const ring=tile?.querySelector('[data-speaking-tile-ring]')
      return tile?.getAttribute('data-speaking')===String(on)&&ring&&Number(getComputedStyle(ring).opacity)===(on?1:0)
    }),{id,on})
    if(on)for(const scope of ['[data-main-speaking]','[data-mini-speaking]']){
      const ring=page.locator(`${scope} [data-participant-id="${id}"] [data-speaking-tile-ring]`)
      assert.equal(await ring.isVisible(),true)
      assert.notEqual(await ring.evaluate(el=>getComputedStyle(el).boxShadow),'none','speaking overlay must have a visible border/glow')
      assert.ok(await ring.evaluate(el=>{
        const tile=el.parentElement,media=tile.querySelector('video,img'),r=el.getBoundingClientRect(),t=tile.getBoundingClientRect()
        return getComputedStyle(el).visibility==='visible'&&Number(getComputedStyle(el).zIndex)>(Number(getComputedStyle(media).zIndex)||0)&&Math.abs(r.width-t.width)<1&&Math.abs(r.height-t.height)<1
      }),'green overlay must cover the tile above the camera image')
    }
  }
  await checkRing('self',false);await checkRing('remote',false)
  await page.evaluate(()=>window.fixture.localRms(0.1,100))
  await checkRing('self',true)
  await page.evaluate(()=>window.fixture.localRms(0,400))
  await checkRing('self',false)
  await page.evaluate(()=>window.fixture.legacy(0.7))
  await checkRing('remote',true)
  await page.evaluate(()=>window.fixture.legacy(0))
  await checkRing('remote',false)
  console.log('PASS main stage and mini camera tiles: local microphone and legacy voice levels light visible green borders; silence clears')
  await page.evaluate(()=>{window.fixture.localRms(0.1,500);window.fixture.update({selfMuted:true,remoteSpeaking:true})})
  await checkRing('self',false)
  await checkRing('remote',true)
  await page.evaluate(()=>window.fixture.update({remoteMuted:true}))
  await checkRing('remote',false)
  await page.evaluate(()=>{window.fixture.legacy(0);window.fixture.update({selfMuted:false,remoteMuted:false,remoteSpeaking:false,remoteSource:'sfu'});window.fixture.sfu(0.75)})
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-participant-id="remote"] video')].length===2&&[...document.querySelectorAll('[data-participant-id="remote"] video')].every(video=>video.videoWidth>0))
  await checkRing('remote',true)
  await checkRing('remote',false) // SFU's500ms lease must clear a stalled/disconnected speaker.
  await page.evaluate(()=>window.fixture.localRms(0.1,600))
  await checkRing('self',true)
  await checkRing('self',false) // Local capture's400ms lease must also expire.
  console.log('PASS mute overrides stale speaking flags; SFU and local video borders expire when activity updates stop')
  await page.evaluate(()=>{window.fixture.update({cameras:false,miniView:'avatars'});window.fixture.localRms(0.1,700);window.fixture.legacy(0.7)})
  await page.waitForFunction(()=>!document.querySelector('[data-mini-camera-grid]')&&document.querySelectorAll('[data-main-speaking] video').length===0)
  await page.waitForFunction(()=>['[data-main-speaking]','[data-mini-speaking]'].every(scope=>[...document.querySelectorAll(`${scope} [data-speaking-ring]`)].some(ring=>Number(getComputedStyle(ring).opacity)>0)))
  await page.evaluate(()=>{window.fixture.localRms(0,1000);window.fixture.legacy(0)})
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-speaking-ring]')].every(ring=>Number(getComputedStyle(ring).opacity)===0))
  console.log('PASS avatars retain speaking rings with cameras disabled and clear after silence')
  await page.evaluate(()=>window.fixture.unmount())
}finally{
  await browser?.close()
  if(server)await new Promise(resolve=>server.close(resolve))
  await rm(output,{recursive:true,force:true})
}
