// JSのDSPがPython(analysis/sonify.py)とどれだけ一致するかを測る。
// 使い方: node tools/compare_with_python.js <sensor.csv> <cutoff> <python.json>
const fs = require('fs');
const S = require('../js/sonify.js');

const [csvPath, cutoffStr, pyPath] = process.argv.slice(2);
const cutoff = parseFloat(cutoffStr);

// CSVを読み、Python側(load_side)と同じ手順で200Hzの等間隔系列にする
const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
const head = lines[0].split(',');
const iTs = head.indexOf('timestamp'), iGx = head.indexOf('gyro_x');
const rows = lines.slice(1).map(l => l.split(','))
  .map(c => ({ ts: +c[iTs], gx: +c[iGx] }));
// 同一タイムスタンプに4行 → 5msずつずらす（Python側と同じ）
const cnt = new Map(); const up = [];
for (const r of rows) {
  const k = cnt.get(r.ts) || 0; cnt.set(r.ts, k + 1);
  up.push({ t: r.ts + k * 5, gx: r.gx });
}
up.sort((a, b) => a.t - b.t);
const t0 = JSON.parse(fs.readFileSync(csvPath.replace(/_(left|right)_sensor\.csv$/, '_meta.json'), 'utf8'))
  .feet[/_left_/.test(csvPath) ? 'left' : 'right'].start_beep_sensor_ts;
const tRel = up.map(r => r.t - t0);
const start = Math.max(0, tRel[0]);
const grid = []; for (let x = start; x < tRel[tRel.length - 1]; x += 5) grid.push(x);
const gyro = grid.map(x => {
  let i = 0; while (i < tRel.length - 2 && tRel[i + 1] < x) i++;
  const f = (x - tRel[i]) / (tRel[i + 1] - tRel[i] || 1);
  return up[i].gx + (up[i + 1].gx - up[i].gx) * f;
});

const r = S.analytic(gyro, 200, cutoff);
const py = JSON.parse(fs.readFileSync(pyPath, 'utf8'));

// Python側は 24〜30秒を切り出している。同じ区間をJS側からも取る
const i0 = grid.findIndex(x => x >= 24000), i1 = i0 + py.sig.length;
const jsSig = Array.from(r.sig).slice(i0, i1);
const jsAmp = Array.from(r.amp).slice(i0, i1);
const jsPh = Array.from(r.phase).slice(i0, i1);

function stats(name, a, b, unit) {
  const n = Math.min(a.length, b.length);
  let se = 0, mx = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]); se += d * d; if (d > mx) mx = d; sb += Math.abs(b[i]);
  }
  const rms = Math.sqrt(se / n), mean = sb / n;
  console.log(`  ${name.padEnd(8)} RMS差 ${rms.toExponential(2)} ${unit}   最大差 ${mx.toExponential(2)}   相対 ${(rms / (mean || 1) * 100).toFixed(4)}%`);
  return rms / (mean || 1);
}
console.log(`比較 n=${jsSig.length}  cutoff=${cutoff}Hz`);
stats('ローパス後', jsSig, py.sig, 'deg/s');
stats('振幅', jsAmp, py.amp, 'deg/s');
// 位相はアンラップの絶対オフセットが違いうるので、差の分散で見る
const n = Math.min(jsPh.length, py.phase.length);
const diffs = []; for (let i = 0; i < n; i++) diffs.push(jsPh[i] - py.phase[i]);
const mu = diffs.reduce((s, x) => s + x, 0) / n;
let v = 0; for (const d of diffs) v += (d - mu) ** 2;
console.log(`  位相     平均ずれ ${(mu * 180 / Math.PI).toFixed(3)}°   ばらつき(SD) ${(Math.sqrt(v / n) * 180 / Math.PI).toFixed(4)}°`);
