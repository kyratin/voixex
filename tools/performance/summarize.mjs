import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
export function quantile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}
const maximum = values => values.length ? values.reduce((a, b) => Math.max(a, b), -Infinity) : null
const minimum = values => values.length ? values.reduce((a, b) => Math.min(a, b), Infinity) : null
export function summarize(raw) {
  const { config: c, measure, stop, clientReports: reports, server, observer } = raw
  const peers = reports.flatMap(report => report.peers)
  const resources = server.resources.filter(row => row.at >= measure && row.at <= stop)
  const snapshots = server.stats.filter(row => row.at >= measure && row.at <= stop)
  const sum = key => snapshots.reduce((total, row) => total + (row[key] || 0), 0)
  const probes = reports.flatMap(report => report.probeRtt)
  const gaps = reports.flatMap(report => report.gaps)
  const markers = reports.flatMap(report => report.markerLatencies)
  const played = sum('played'), concealed = sum('concealed')
  return {
    name: c.name, users: c.users, speakers: c.speakers, rooms: c.rooms,
    transport: c.transport, cameras: c.cameras || 0, seconds: c.seconds,
    openMicSilent: c.openMicSilent || false,
    cpuAvgPct: resources.reduce((total, row) => total + row.cpuPct, 0) / resources.length,
    cpuMaxPct: maximum(resources.map(row => row.cpuPct)),
    rssMaxMiB: maximum(resources.map(row => row.rssMiB)),
    workerLoopP99MaxMs: maximum(snapshots.map(row => row.loopDelayP99Ms)),
    workerLoopMaxMs: maximum(snapshots.map(row => row.loopDelayMaxMs)),
    receiveFpsMedian: quantile(peers.map(peer => peer.audio / c.seconds), .5),
    receiveFpsMin: minimum(peers.filter(peer => peer.expected).map(peer => peer.audio / c.seconds)),
    probeRttP95Ms: quantile(probes, .95), probeRttP99Ms: quantile(probes, .99),
    audioGapP99Ms: quantile(gaps, .99), audioGapMaxMs: maximum(gaps),
    markerLatencyP50Ms: quantile(markers, .5), markerLatencyP95Ms: quantile(markers, .95),
    markerSamples: markers.length,
    generatorLoopP99MaxMs: maximum(reports.map(report => report.generatorLoopP99Ms)),
    generatorSkippedTicks: reports.reduce((total, report) => total + report.skippedTicks, 0),
    helloAcknowledged: peers.filter(peer => peer.hello).length,
    decoded: played, concealed, concealmentPct: 100 * concealed / (played + concealed || 1),
    lateDrops: sum('lateDrops'), catchupDrops: sum('catchupDrops'), hardDrops: sum('hardDrops'),
    decodeErrors: sum('decodeErrors'), encodeErrors: sum('txEncodeErrors'),
    tcpBacklogDropped: sum('tcpBacklogDropped'), workerErrors: server.errors.length,
    cameraRxPackets: peers.reduce((total, peer) => total + peer.camera, 0),
    audioRxPackets: peers.reduce((total, peer) => total + peer.audio, 0),
    observer: observer || null, output: c.output
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = JSON.parse(await readFile(process.argv[2], 'utf8'))
  console.log(JSON.stringify(summarize(raw)))
}
