import {spawn} from 'node:child_process'
import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises'
const out='/tmp/voixex-performance',cases=[['audio4-subs50',4,0,50],['audio25-subs25',25,0,25],['video12-audio4-subs12',4,12,12],['video1-audio4-subs50',4,1,50]]
while(true){try{if((await readFile(`${out}/api-matrix.jsonl`,'utf8')).trim().split('\n').length>=7)break}catch{}await new Promise(r=>setTimeout(r,1000))}
for(const [name,audio,video,subscribers]of cases.filter(row=>!process.env.CASE_FILTER||new RegExp(process.env.CASE_FILTER).test(row[0]))){
 const samples=[],sampler=spawn('docker',['stats','--format','{{json .}}','voixex-perf-livekit'])
 let pending='';sampler.stdout.on('data',data=>{pending+=data;const lines=pending.split('\n');pending=lines.pop();for(const l of lines)if(l.trim())try{samples.push({at:Date.now(),...JSON.parse(l.replace(/\x1b\[[0-9;]*[A-Za-z]/g,""))})}catch{}})
 const args=['run','--rm','--name','voixex-perf-lk-generator','--network','voixex-perf-net','--cpus','4','--memory','2048m','--entrypoint','/lk/lk','--mount',`type=bind,src=${out}/lk-linux,dst=/lk,readonly`,'kyratinkokko/voixex@sha256:cd37a983383ca786e8bb4e71f9343f680f4c3d69a9843cec53db4b421f1a9aaa','--url','ws://voixex-perf-livekit:17880','--api-key','perfkey','--api-secret','isolated-benchmark-livekit-secret','load-test','--room',name,'--duration','30s','--audio-publishers',String(audio),'--video-publishers',String(video),'--subscribers',String(subscribers),'--num-per-second','50','--layout',audio>16?'5x5':'4x4','--no-simulcast','--video-resolution','high','--video-codec','vp8']
 const start=Date.now(),result=await new Promise((resolve,reject)=>{const p=spawn('docker',args,{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.on('error',reject);p.on('exit',code=>resolve({code,stdout,stderr}))})
 sampler.kill('SIGTERM')
 const resultFile=`${out}/livekit-${name}.json`;await writeFile(resultFile,JSON.stringify({name,audio,video,subscribers,start,stop:Date.now(),...result,samples}))
 console.log(JSON.stringify({name,code:result.code,cpuMaxPct:Math.max(...samples.map(s=>parseFloat(s.CPUPerc))),resultFile,tail:(result.stdout+result.stderr).slice(-2400)}))
}
