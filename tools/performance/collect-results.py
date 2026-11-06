"""Collect auditable, synthetic-only results; exclude invalid exploratory pilots."""
import csv
import gzip
import json
import pathlib
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = pathlib.Path('/tmp/voixex-performance')
TARGET = ROOT / 'docs/performance/data'
TARGET.mkdir(parents=True, exist_ok=True)
media = []
for directory in ('final', 'extra'):
    for path in sorted((SOURCE / directory).glob('*.raw.json')):
        # Recompute with the same summary implementation, including long runs.
        summary = json.loads(subprocess.check_output(
            ['node', str(ROOT / 'tools/performance/summarize.mjs'), str(path)]))
        summary['output'] = path.name
        media.append(summary)
        raw = json.loads(path.read_text())
        raw['config']['backend'] = '/app'
        raw['config']['output'] = path.name
        raw['config'].pop('clientRoot', None)
        with gzip.open(TARGET / (path.name + '.gz'), 'wt') as output:
            json.dump(raw, output, separators=(',', ':'))
(TARGET / 'media-summary.json').write_text(json.dumps(media, indent=2) + '\n')
fields = ['name','users','speakers','openMicSilent','cameras','cpuAvgPct','rssMaxMiB',
          'receiveFpsMedian','receiveFpsMin','concealmentPct','hardDrops',
          'probeRttP95Ms','markerLatencyP95Ms','workerLoopP99MaxMs','generatorSkippedTicks']
with (TARGET / 'media-summary.csv').open('w') as output:
    writer = csv.DictWriter(output, fields, extrasaction='ignore')
    writer.writeheader()
    writer.writerows(media)
for name in ('m4-core-cost', 'xeon-core-cost', 'gold-core-cost', 'codec-cost'):
    (TARGET / (name + '.json')).write_bytes((SOURCE / (name + '.json')).read_bytes())
api = []
for line in (SOURCE / 'api-matrix.jsonl').read_text().splitlines():
    result = json.loads(line)
    summary = json.loads(result['stdout'])
    summary['exitCode'] = result['code']
    summary['durationSec'] = (result['stop'] - result['start']) / 1000
    api.append(summary)
    file = f"api-{result['mode']}-{result['vus']}.json"
    (TARGET / file).write_bytes((SOURCE / file).read_bytes())
(TARGET / 'api-summary.json').write_text(json.dumps(api, indent=2) + '\n')
sfu = []
for path in sorted(SOURCE.glob('livekit-*.json')):
    raw = json.loads(path.read_text())
    samples = [float(row['CPUPerc'].rstrip('%')) for row in raw['samples']
               if raw['stop'] - 25000 < row['at'] < raw['stop'] - 2000]
    totals = [line for line in raw['stdout'].splitlines() if '│ Total ' in line]
    total = totals[-1] if totals else ''
    sfu.append({'name':raw['name'], 'audioPublishers':raw['audio'],
                'videoPublishers':raw['video'], 'subscribers':raw['subscribers'],
                'cpuSteadyAvgPct':sum(samples)/len(samples) if samples else None,
                'cpuSteadyMaxPct':max(samples) if samples else None,
                'totalRow':total, 'exitCode':raw['code']})
    with gzip.open(TARGET / (path.name + '.gz'), 'wt') as output:
        json.dump(raw, output, separators=(',', ':'))
(TARGET / 'livekit-summary.json').write_text(json.dumps(sfu, indent=2) + '\n')
(TARGET / 'synthetic-observer-5s.wav').write_bytes(
    (SOURCE / 'extra/soak-20-openmic-s4.wav').read_bytes())
print(f'Collected {len(media)} media scenarios, {len(api)} API scenarios and {len(sfu)} SFU scenarios')
