// Manual macOS probe: requires pre-granted recording permissions and an external 1000Hz player.
// Analyzes audio in memory; never records screen contents. Not part of unattended CI.
const {app,BrowserWindow,desktopCapturer,session,systemPreferences}=require('electron')
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required')
app.whenReady().then(async()=>{
 if(process.platform!=='darwin'){console.log('NATIVE_PROBE_BLOCKED this manual probe is macOS-only');app.exit(0);return}
 const permission=systemPreferences.getMediaAccessStatus('screen')
 console.log('SCREEN_PERMISSION '+permission)
 if(permission!=='granted'){console.log('NATIVE_PROBE_BLOCKED screen permission not pregranted');app.exit(0);return}
 session.defaultSession.setDisplayMediaRequestHandler(async(request,callback)=>{const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:0,height:0}});callback({video:sources[0],audio:'loopback'})},{useSystemPicker:false})
 const window=new BrowserWindow({width:320,height:180,show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}})
 const server=require('node:http').createServer((req,res)=>res.end('<html><body>Voixex local audio exclusion probe</body></html>'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 await window.loadURL('http://127.0.0.1:'+server.address().port)
 const result=await window.webContents.executeJavaScript(`(async()=>{
  const idleFirst=${process.env.VOIXEX_PROBE_IDLE_FIRST==='1'?'true':'false'};
  let context,osc;
  async function startOwn(){context=new AudioContext();osc=context.createOscillator();const gain=context.createGain();osc.frequency.value=440;gain.gain.value=0.012;osc.connect(gain);gain.connect(context.destination);osc.start();await context.resume()}
  if(!idleFirst){await startOwn();await new Promise(resolve=>setTimeout(resolve,150))}
  const stream=await navigator.mediaDevices.getDisplayMedia({video:{width:16,height:16,frameRate:1},audio:{restrictOwnAudio:${process.env.VOIXEX_PROBE_RESTRICT==='0'?'false':'true'},suppressLocalAudioPlayback:false,echoCancellation:false,noiseSuppression:false,autoGainControl:false},systemAudio:'include'});
  const track=stream.getAudioTracks()[0];if(!track||track.readyState!=='live'){stream.getTracks().forEach(t=>t.stop());if(osc)osc.stop();if(context)await context.close();return{blocked:'No live system audio track'}}
  require('electron').ipcRenderer.send('probe:ready');
  if(idleFirst){await new Promise(resolve=>setTimeout(resolve,1000));await startOwn()}
  const source=context.createMediaStreamSource(new MediaStream([track])),analyser=context.createAnalyser(),pump=context.createGain();analyser.fftSize=8192;pump.gain.value=0;source.connect(analyser);analyser.connect(pump);pump.connect(context.destination);
  let own=0,external=0;const data=new Float32Array(8192);for(let n=0;n<15;n++){await new Promise(r=>setTimeout(r,100));analyser.getFloatTimeDomainData(data);for(const f of [440,1000]){let re=0,im=0;for(let i=0;i<data.length;i++){const a=2*Math.PI*f*i/context.sampleRate;re+=data[i]*Math.cos(a);im+=data[i]*Math.sin(a)}const amplitude=2*Math.hypot(re,im)/data.length;if(f===440)own=Math.max(own,amplitude);else external=Math.max(external,amplitude)}}
  const settings=track.getSettings();stream.getTracks().forEach(t=>t.stop());osc.stop();await context.close();return{restrictOwnAudio:settings.restrictOwnAudio??null,suppressLocalAudioPlayback:settings.suppressLocalAudioPlayback??null,own440:own,external1000:external,ratio:external?own/external:null};
 })()`,true).catch(error=>({blocked:String(error)}))
 console.log('NATIVE_PROBE_RESULT '+JSON.stringify(result));app.exit(0)
}).catch(error=>{console.error(error);app.exit(1)})
require('electron').ipcMain.on('probe:ready',()=>console.log('CAPTURE_READY'))
setTimeout(()=>{console.log('NATIVE_PROBE_BLOCKED permission or capture startup timed out');app.exit(0)},12000)
