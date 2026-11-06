import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
root = Path(__file__).resolve().parents[2]
data = root / 'docs/performance/data'
rows = {r['name']: r for r in json.loads((data/'media-summary.json').read_text())}
gold = json.loads((data/'gold-core-cost.json').read_text())['results']
fig, axes = plt.subplots(1, 3, figsize=(16, 4.8), layout='constrained')
ax = axes[0]
labels = ['10 / 4', '20 / 4', '30 / 4', '20 / 20', '12 / 4\n3 cams', '12 / 4\n12 cams']
values = [r['cpuCoresRequired'] for r in gold]
ax.bar(labels, values, color=['#3973ac' if v<.7 else '#d98d27' if v<1 else '#bf4945' for v in values])
ax.axhline(1, color='#bf4945', linestyle='--', label='one physical CPU')
ax.set(title='Production-node CPU calibration', ylabel='CPU cores required by media computation', xlabel='Participants / input sources')
ax.tick_params(axis='x', labelsize=8)
ax.legend(fontsize=8)
ax = axes[1]
for names, label, color in [([f'udp-{n}-s4-1cpu' for n in [10,25,50,100]], '4 sources; other mics muted', '#3973ac'),([f'openmic-{n}-s4' for n in [20,50,100]], '4 sources; other mics open/quiet', '#d98d27'),([f'udp-{n}-all-1cpu' for n in [10,25,50,100]], 'Everyone transmits non-silent audio', '#bf4945')]:
    rr=[rows[n] for n in names]
    ax.plot([r['users'] for r in rr],[r['receiveFpsMedian'] for r in rr],'-o',label=label,color=color)
ax.axhline(50,color='#666',linestyle=':')
ax.set(title='M4/Linux one-CPU network target',ylabel='Median received 20 ms frames per second',xlabel='Participants',ylim=(0,55))
ax.legend(fontsize=7,loc='lower left')
ax = axes[2]
rr=[rows['udp-100-all-1cpu'],rows['2cpu-100-all']]
ax.bar(['1 CPU allocation','2 CPU allocation'],[r['receiveFpsMedian'] for r in rr],color=['#3973ac','#bf4945'])
ax.axhline(50,color='#666',linestyle=':',label='real-time target')
ax.set(title='100 speakers: allocation is not parallelism',ylabel='Median received frames per second',ylim=(0,55))
ax.legend(fontsize=8)
fig.suptitle('Voixex 0.7.3 capacity audit — synthetic media, 2026-11-06',fontsize=14)
fig.savefig(data/'capacity.svg')
fig.savefig(data/'capacity.png',dpi=150)
