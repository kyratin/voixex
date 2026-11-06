import { spawn } from 'node:child_process'
import { mkdir, writeFile, appendFile } from 'node:fs/promises'
const dir=process.env.BENCH_OUTPUT||'/tmp/voixex-performance'
await mkdir(dir,{recursive:true})
const backend=process.env.BACKEND_ROOT||'/app'
const cases=[
 ['udp-10-s4',10,4,1,'udp',0],['udp-25-s4',25,4,1,'udp',0],['udp-50-s4',50,4,1,'udp',0],['udp-100-s4',100,4,1,'udp',0],
 ['udp-10-all',10,10,1,'udp',0],['udp-25-all',25,25,1,'udp',0],['udp-50-all',50,50,1,'udp',0],['udp-100-all',100,100,1,'udp',0],
 ['tcp-50-s4',50,4,1,'tcp',0],['ws-50-s4',50,4,1,'ws',0],['mixed-50-s4',50,4,1,'mixed',0],
 ['udp-100-10rooms',100,20,10,'udp',0],['udp-12-cam3',12,4,1,'udp',3],['udp-12-cam6',12,4,1,'udp',6],['udp-12-cam12',12,4,1,'udp',12],
 ['udp-100-silent',100,0,1,'udp',0]
]
const run=(cmd,args)=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,{stdio:['ignore','pipe','inherit']});let out='';p.stdout.on('data',d=>{out+=d;process.stdout.write(d)});p.on('error',reject);p.on('exit',code=>code?reject(new Error(`${cmd} exited ${code}`)):resolve(out.trim()))})
for(const [name,users,speakers,rooms,transport,cameras]of cases.filter(row=>!process.env.CASE_FILTER||new RegExp(process.env.CASE_FILTER).test(row[0]))){
 const config={name:`${name}-1cpu`,users,speakers,rooms,transport,cameras,cameraBytes:10000,seconds:20,warmupSec:5,api:process.env.API_BASE||'http://voixex-perf-media:18080',port:50000,backend,output:`${dir}/${name}-1cpu.raw.json`}
 const file=`${dir}/case.json`;await writeFile(file,JSON.stringify(config))
 const result=await run(process.execPath,[new URL('./media-clients.mjs',import.meta.url).pathname,file]);await appendFile(`${dir}/matrix.jsonl`,result+'\n')
}
