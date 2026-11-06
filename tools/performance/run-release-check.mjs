/** Focused release regression on a private Docker bridge; no production ports or volumes. */
import {spawn} from 'node:child_process'
import {mkdir,writeFile,appendFile} from 'node:fs/promises'
import {resolve} from 'node:path'
const root=process.cwd(),out=resolve(process.env.RELEASE_BENCH_OUTPUT||'/tmp/voixex-performance/0.8.0'),image=process.env.RELEASE_BENCH_IMAGE||'voixex-server:0.8.0-arm64'
const network='voixex-release-perf-net',server='voixex-release-perf-media'
const command=(cmd,args)=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,{stdio:['ignore','pipe','inherit']});let text='';p.stdout.on('data',d=>{text+=d;process.stdout.write(d)});p.once('error',reject);p.once('exit',code=>code?reject(new Error(`${cmd}: exit ${code}`)):resolve(text.trim()))})
await mkdir(out,{recursive:true})
await command('docker',['network','create',network])
try{
 await command('docker',['run','--rm','-d','--name',server,'--network',network,'--cpus','1','--memory','1536m','--entrypoint','node','-e','TOKEN_SECRET=isolated-release-check-only','-e','UDP_PORT=50000','-e','UDP_HOST=0.0.0.0','--mount',`type=bind,src=${root}/tools/performance,dst=/bench,readonly`,image,'/bench/media-server.mjs'])
 const cases=[['compat-open100-s4',100,4,true,'opus2 camera1',false,20],['mix3-open100-s4',100,4,true,'opus2 camera1 mix3',false,20],['mix3-open100-silent',100,0,true,'opus2 camera1 mix3',false,20],['mix3-soak20-s4',20,4,true,'opus2 camera1 mix3',true,120]]
 for(const [name,users,speakers,openMicSilent,clientCaps,observer,seconds] of cases){
  const c={name,users,speakers,rooms:1,transport:'udp',cameras:0,seconds,warmupSec:5,openMicSilent,clientCaps,observer,clientRoot:'/client',api:`http://${server}:18080`,port:50000,backend:'/app',output:`/results/${name}.raw.json`}
  await writeFile(`${out}/case.json`,JSON.stringify(c))
  const result=await command('docker',['run','--rm','--name','voixex-release-perf-generator','--network',network,'--cpus','4','--memory','2048m','--entrypoint','node','--mount',`type=bind,src=${root}/tools/performance,dst=/bench,readonly`,'--mount',`type=bind,src=${root}/voice-client,dst=/client,readonly`,'--mount',`type=bind,src=${out},dst=/results`,image,'/bench/media-clients.mjs','/results/case.json'])
  await appendFile(`${out}/matrix.jsonl`,result+'\n')
 }
}finally{
 await command('docker',['rm','-f',server]).catch(()=>{})
 await command('docker',['network','rm',network]).catch(()=>{})
}
