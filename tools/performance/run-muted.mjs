import {spawn} from 'node:child_process'
import {readFile,writeFile,appendFile} from 'node:fs/promises'
const root=process.cwd(),out='/tmp/voixex-performance/extra'
while(true){try{const rows=(await readFile(`${out}/matrix.jsonl`,'utf8')).trim().split('\n').map(JSON.parse);if(rows.some(r=>r.name==='soak-20-openmic-s4'))break}catch{}await new Promise(r=>setTimeout(r,1000))}
const config={name:'muted-1000',users:1000,speakers:0,rooms:1,transport:'udp',cameras:0,seconds:20,startDelayMs:10000,warmupSec:8,api:'http://voixex-perf-media:18080',port:50000,backend:'/app',output:'/results/extra/muted-1000.raw.json'}
await writeFile(`${out}/muted.json`,JSON.stringify(config))
const args=['run','--rm','--name','voixex-perf-generator','--network','voixex-perf-net','--cpus','6','--memory','3072m','--ulimit','nofile=65535:65535','--entrypoint','node','--mount',`type=bind,src=${root}/tools/performance,dst=/bench,readonly`,'--mount','type=bind,src=/tmp/voixex-performance,dst=/results','kyratinkokko/voixex@sha256:cd37a983383ca786e8bb4e71f9343f680f4c3d69a9843cec53db4b421f1a9aaa','/bench/media-clients.mjs','/results/extra/muted.json']
const result=await new Promise((resolve,reject)=>{const p=spawn('docker',args,{stdio:['ignore','pipe','inherit']});let stdout='';p.stdout.on('data',d=>{stdout+=d;process.stdout.write(d)});p.on('error',reject);p.on('exit',code=>code?reject(new Error(`generator ${code}`)):resolve(stdout.trim()))})
await appendFile(`${out}/matrix.jsonl`,result+'\n')
