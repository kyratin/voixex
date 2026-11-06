import {spawn} from 'node:child_process'
import {writeFile,appendFile,readFile,mkdir} from 'node:fs/promises'
const root=process.cwd(),dir='/tmp/voixex-performance',out=`${dir}/extra`
await mkdir(out,{recursive:true})
// Run after the separate SFU matrix, so sustained media tests do not compete with it.
while(true){try{const s=JSON.parse(await readFile(`${dir}/livekit-video1-audio4-subs50.json`,'utf8'));if(s.samples.length>0)break}catch{}await new Promise(r=>setTimeout(r,1000))}
const command=(cmd,args)=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,{stdio:['ignore','pipe','inherit']});let output='';p.stdout.on('data',d=>{output+=d;process.stdout.write(d)});p.on('error',reject);p.on('exit',code=>code?reject(new Error(`${cmd} ${code}`)):resolve(output.trim()))})
await command('docker',['rm','-f','voixex-perf-media'])
await command('docker',['run','--rm','-d','--name','voixex-perf-media','--network','voixex-perf-net','--cpus','1','--memory','1536m','--entrypoint','node','-e','TOKEN_SECRET=isolated-benchmark-only','-e','UDP_PORT=50000','-e','UDP_HOST=0.0.0.0','--mount',`type=bind,src=${root}/tools/performance,dst=/bench,readonly`,'kyratinkokko/voixex@sha256:cd37a983383ca786e8bb4e71f9343f680f4c3d69a9843cec53db4b421f1a9aaa','/bench/media-server.mjs'])
await new Promise(r=>setTimeout(r,1000))
const cases=[['openmic-20-s4',20,4,1,true,20,false],['openmic-50-s4',50,4,1,true,20,false],['openmic-100-s4',100,4,1,true,20,false],['openmic-100-silent',100,0,1,true,20,false],['muted-1000',1000,0,1,false,20,false],['2cpu-100-all',100,100,2,false,20,false],['2cpu-100-s4',100,4,2,false,20,false],['soak-20-openmic-s4',20,4,1,true,120,true]]
for(const [name,users,speakers,cpus,openMicSilent,seconds,observer]of cases){
 await command('docker',['update','--cpus',String(cpus),'voixex-perf-media'])
 const config={name,users,speakers,rooms:1,transport:'udp',cameras:0,seconds,startDelayMs:users>200?10000:3500,warmupSec:8,openMicSilent,observer,clientRoot:'/client/voice-client',api:'http://voixex-perf-media:18080',port:50000,backend:'/app',output:`/results/extra/${name}.raw.json`}
 await writeFile(`${out}/case.json`,JSON.stringify(config))
 const args=['run','--rm','--name','voixex-perf-generator','--network','voixex-perf-net','--cpus','4','--memory','2048m','--entrypoint','node','--mount',`type=bind,src=${root}/tools/performance,dst=/bench,readonly`,'--mount',`type=bind,src=${root}/voice-client,dst=/client/voice-client,readonly`,'--mount',`type=bind,src=${dir},dst=/results`,'kyratinkokko/voixex@sha256:cd37a983383ca786e8bb4e71f9343f680f4c3d69a9843cec53db4b421f1a9aaa','/bench/media-clients.mjs','/results/extra/case.json']
 const result=await command('docker',args);await appendFile(`${out}/matrix.jsonl`,result+'\n')
}
