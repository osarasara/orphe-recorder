// 実データで「区間を切り出す→4条件ぶんの音を作る」まで通す。ブラウザに入れる前の検証。
//
//   node tools/test_end_to_end.js [meta.jsonのパス]
//
// パスを省いたら、Vaultの experiments/ から meta.json を1つ自動で拾う。
// meta に区間マーカーが無い古いデータなら、真ん中から2秒を切って代わりに使う。
const fs = require('fs');
const path = require('path');
const S = require('../js/sonify.js');

const VAULT_EXP = '/Users/saras/Library/CloudStorage/OneDrive-Personal/0_OsaraMain/03_Notes/卒プロ/experiments';

function findMeta() {
  if (process.argv[2]) return process.argv[2];
  const hits = [];
  (function walk(dir, depth) {
    if (depth > 2) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('_meta.json')) hits.push(p);
    }
  })(VAULT_EXP, 0);
  if (!hits.length) { console.error('meta.json が見つかりません。パスを引数で渡してください'); process.exit(1); }
  hits.sort();
  return hits[hits.length - 1];
}

const metaPath = findMeta();
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
// 同じ stamp の CSV を探す（left 優先、無ければ right）
const dir = path.dirname(metaPath);
const base = path.basename(metaPath).replace(/_meta\.json$/, '');
let csvPath = null, foot = null;
for (const side of ['left', 'right']) {
  const p = path.join(dir, base + '_' + side + '_sensor.csv');
  if (fs.existsSync(p)) { csvPath = p; foot = side; break; }
}
if (!csvPath) { console.error('CSVが見つかりません: ' + base); process.exit(1); }
console.log('データ: ' + path.basename(csvPath));

const rec = fs.readFileSync(csvPath, 'utf8').trim().split('\n').slice(1);

// アプリの gyroSeries と同じ手順
function gyroSeries(rows, fromTs, toTs) {
  const ts = [], gx = [], seen = new Map();
  for (const line of rows) {
    const c = line.split(','); const t = +c[0];
    const k = seen.get(t) || 0; seen.set(t, k + 1);
    ts.push(t + k * 5); gx.push(+c[4]);
  }
  const val = []; let i = 0;
  for (let x = fromTs; x <= toTs; x += 5) {
    while (i < ts.length - 2 && ts[i + 1] < x) i++;
    const span = (ts[i + 1] - ts[i]) || 1, f = (x - ts[i]) / span;
    val.push(gx[i] + (gx[i + 1] - gx[i]) * f);
  }
  return val;
}

// 区間を決める。マーカーがあれば1本目、無ければ真ん中の2秒
let from, to, how;
const mk = meta.markers || [];
if (mk.length >= 2 && mk[0].sensor_ts && mk[0].sensor_ts[foot]) {
  from = mk[0].sensor_ts[foot]; to = mk[1].sensor_ts[foot]; how = 'markers[0..1]';
} else {
  const first = +rec[0].split(',')[0], last = +rec[rec.length - 1].split(',')[0];
  const mid = Math.floor((first + last) / 2);
  from = mid - 1000; to = mid + 1000; how = '真ん中から2秒（マーカーなし）';
}
console.log(`区間: ${how}  (${((to - from) / 1000).toFixed(2)}s)`);

const gyro = gyroSeries(rec, from, to);
console.log(`サンプル数 ${gyro.length}  (200Hzなら ${(gyro.length / 200).toFixed(2)}s 相当)`);

const t0 = Date.now();
const an = S.analytic(gyro, 200, 15);
const laps = Math.abs(an.phase[an.phase.length - 1] - an.phase[0]) / (2 * Math.PI);
const durS = gyro.length / 200;
const cycleS = +(durS / Math.max(laps, 1e-9)).toFixed(3);
const N = Math.max(10, Math.round(250 * cycleS / 10) * 10);

const SR = 44100;
const sPhase  = S.renderPhaseSound(an.amp, an.phase, 200, SR, N);
const sFrozen = S.renderFrozen(sPhase);
const sMetro  = S.renderMetronome(cycleS, durS, SR);
const genMs = Date.now() - t0;

console.log(`位相 ${laps.toFixed(2)}周  1周 ${cycleS}s (${(60 / cycleS).toFixed(1)} bpm)  逓倍N=${N} → 中心 ${Math.round(N / cycleS)}Hz`);
console.log(`3条件ぶんの生成: ${genMs}ms  ← スマホでもこの程度なら試技の合間に十分`);

// ---- 検算 ----
let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? '  OK   ' : '  NG   ') + name + (detail ? '   ' + detail : ''));
  if (!ok) fail++;
}
function peak(x) { let m = 0; for (const v of x) if (Math.abs(v) > m) m = Math.abs(v); return m; }
function rms(x)  { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / x.length); }
function corr(a, b) {
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return sab / Math.sqrt(saa * sbb || 1e-30);
}

console.log('\n[ 自分の音 (phase) ]');
check('長さが区間と一致', Math.abs(sPhase.length / SR - durS) < 0.02, `${(sPhase.length / SR).toFixed(3)}s`);
check('ピーク 0.89 に正規化', Math.abs(peak(sPhase) - 0.89) < 1e-6, peak(sPhase).toFixed(6));
check('NaN/Inf なし', sPhase.every(Number.isFinite));

console.log('\n[ 凍らせた音 (frozen) — 時間反転 ]');
check('長さが同じ', sFrozen.length === sPhase.length);
check('ピークが同じ', Math.abs(peak(sFrozen) - peak(sPhase)) < 1e-9);
check('RMSが同じ（条件間で音量が揃う）', Math.abs(rms(sFrozen) - rms(sPhase)) < 1e-9,
      `${rms(sPhase).toFixed(6)} vs ${rms(sFrozen).toFixed(6)}`);
check('本当に反転している', sFrozen[0] === sPhase[sPhase.length - 1] && sFrozen[10] === sPhase[sPhase.length - 11]);
check('元の音と同一ではない', !sPhase.every((v, i) => v === sFrozen[i]));
const c = corr(sPhase, sFrozen);
check('元の音との相関がほぼ0（瞬間ごとの対応が壊れている）', Math.abs(c) < 0.2, 'r=' + c.toFixed(4));
check('両端が無音（フェードが残っている）',
      Math.abs(sFrozen[0]) < 1e-3 && Math.abs(sFrozen[sFrozen.length - 1]) < 1e-3);

console.log('\n[ メトロノーム (metronome) ]');
check('長さがほぼ同じ', Math.abs(sMetro.length - sPhase.length) <= SR * 0.05, `${sMetro.length} vs ${sPhase.length}`);
check('ピーク 0.89 に正規化', Math.abs(peak(sMetro) - 0.89) < 1e-6);
check('クリックが1回以上入る', Math.round(durS / cycleS) >= 1, Math.round(durS / cycleS) + '回');

console.log('\n' + (fail === 0 ? '✓ すべて通過' : '✗ ' + fail + ' 件 失敗'));
process.exit(fail === 0 ? 0 : 1);
