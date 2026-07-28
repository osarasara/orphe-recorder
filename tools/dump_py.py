import sys, json
sys.path.insert(0, '/Users/saras/Library/CloudStorage/OneDrive-Personal/0_OsaraMain/03_Notes/卒プロ/experiments/260626_一歩/analysis')
import numpy as np, sonify
from pathlib import Path
csv = Path(sys.argv[1]); cut = float(sys.argv[2])
t, a, ph, q, sig = sonify.analytic(csv, cut)
m = (t >= 24) & (t <= 30)
json.dump({'sig': sig[m].tolist(), 'amp': a[m].tolist(), 'phase': ph[m].tolist()}, open(sys.argv[3], 'w'))
print('python: %d samples' % m.sum())
