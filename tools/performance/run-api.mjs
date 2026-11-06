import {createWriteStream} from 'node:fs'
import {spawn} from 'node:child_process'
import {appendFile,writeFile} from 'node:fs/promises'
const root=process.cwd(),out='/tmp/voixex-performance'
const resourceFile=createWriteStream(`${out}/api-resources.jsonl`), sampler=spawn('docker',['stats','--format','{{json .}}','voixex-perf-api']);sampler.stdout.pipe(resourceFile)
const cases=[['read',25],['read',100],['read',250],['write',25],['write',100],['login',10],['login',25]]
for(const [mode,vus]of cases){
 const start=Date.now()
 const args=['run','--rm','--user','0:0','--name','voixex-perf-k6','--network','voixex-perf-net','--cpus','2','--memory','1024m','--mount',`type=bind,src=${root}/tools/performance,dst=/bench,readonly`,'--mount',`type=bind,src=${out},dst=/results`,'-e',`MODE=${mode}`,'-e',`VUS=${vus}`,'-e','DURATION=20s','-e',`OUTPUT=/results/api-${mode}-${vus}.json`,'grafana/k6@sha256:3e4186aea62e11a45560bfc51e19eeafe82fc07ce069c78aff44b7ff893d9a5e','run','--quiet','/bench/api.k6.js']
 const result=await new Promise((resolve,reject)=>{const p=spawn('docker',args,{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.on('error',reject);p.on('exit',code=>resolve({mode,vus,start,stop:Date.now(),code,stdout,stderr}))})
 await appendFile(`${out}/api-matrix.jsonl`,JSON.stringify(result)+'\n')
 console.log(JSON.stringify({mode,vus,code:result.code,summary:result.stdout.trim()}))
}

sampler.kill("SIGTERM");resourceFile.end()
