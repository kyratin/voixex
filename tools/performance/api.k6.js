import http from 'k6/http'
import { check, sleep } from 'k6'
const base=__ENV.API_BASE||'http://voixex-perf-api:8080'
export const options={vus:Number(__ENV.VUS||25),duration:__ENV.DURATION||'30s',summaryTrendStats:['avg','med','p(95)','p(99)','max'],thresholds:{http_req_failed:['rate<0.01'],http_req_duration:['p(95)<200']}}
export function setup(){
 const nick='Benchmark',password='benchmark-profile-local-only'
 http.post(`${base}/v1/auth/register`,JSON.stringify({serverPassword:'benchmark-local-only',nick,authMode:'password',password}),{headers:{'Content-Type':'application/json'}})
 const response=http.post(`${base}/v1/auth/password-login`,JSON.stringify({nick,password,superuserPassword:'api-benchmark-admin-local-only'}),{headers:{'Content-Type':'application/json'}})
 check(response,{'setup login succeeds':r=>r.status===200})
 const auth=response.json(),headers={Authorization:`Bearer ${auth.authToken}`,'Content-Type':'application/json'}
 const rooms=http.get(`${base}/v1/servers/${auth.serverId}/rooms`,{headers}).json().rooms
 return {auth,headers,room:rooms.find(r=>r.kind==='text')?.id,nick,password}
}
export default function(data){
 const mode=__ENV.MODE||'read'
 let response
 if(mode==='login')response=http.post(`${base}/v1/auth/password-login`,JSON.stringify({nick:data.nick,password:data.password}),{headers:{'Content-Type':'application/json'}})
 else if(mode==='health')response=http.get(`${base}/health`)
 else if(mode==='write')response=http.post(`${base}/v1/servers/${data.auth.serverId}/channels/${data.room}/messages`,JSON.stringify({body:`load test ${__VU}:${__ITER}`,attachmentIds:[]}),{headers:data.headers})
 else response=http.get(`${base}/v1/servers/${data.auth.serverId}/rooms`,{headers:data.headers})
 check(response,{'request succeeds':r=>r.status===200})
 sleep(Number(__ENV.THINK_SEC||0.2))
}
export function handleSummary(data){return {'stdout':JSON.stringify({test:__ENV.MODE||'read',vus:options.vus,requests:data.metrics.http_reqs.values.count,rps:data.metrics.http_reqs.values.rate,p95Ms:data.metrics.http_req_duration.values['p(95)'],p99Ms:data.metrics.http_req_duration.values['p(99)'],failedRate:data.metrics.http_req_failed.values.rate,checks:data.metrics.checks.values})+'\n',[__ENV.OUTPUT||'/results/api-summary.json']:JSON.stringify(data,null,2)}}
