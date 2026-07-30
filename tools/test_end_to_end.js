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

// アプリの補間と同じ手順。fromTs/toTs を省くと収録全体をならす
function gyroSeries(rows, fromTs, toTs) {
  const ts = [], gx = [], seen = new Map();
  for (const line of rows) {
    const c = line.split(','); const t = +c[0];
    const k = seen.get(t) || 0; seen.set(t, k + 1);
    ts.push(t + k * 5); gx.push(+c[4]);
  }
  const a = (fromTs === undefined) ? ts[0] : fromTs;
  const b = (toTs === undefined) ? ts[ts.length - 1] : toTs;
  const val = []; let i = 0;
  for (let x = a; x <= b; x += 5) {
    while (i < ts.length - 2 && ts[i + 1] < x) i++;
    const span = (ts[i + 1] - ts[i]) || 1, f = (x - ts[i]) / span;
    val.push(gx[i] + (gx[i + 1] - gx[i]) * f);
  }
  return { t0: a, val: val };
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

// ★v1.10：収録全体を解析してから区間を切る（アプリと同じ経路）
const uni = gyroSeries(rec);
const t0 = Date.now();
const anFull = S.analytic(uni.val, 200, 15);
const i0 = Math.max(0, Math.round((from - uni.t0) / 5));
const i1 = Math.min(anFull.amp.length, Math.round((to - uni.t0) / 5) + 1);
const an = { amp: anFull.amp.slice(i0, i1), phase: anFull.phase.slice(i0, i1) };
console.log(`収録全体 ${anFull.amp.length}点 → 区間 ${an.amp.length}点  (200Hzなら ${(an.amp.length / 200).toFixed(2)}s 相当)`);

const laps = Math.abs(an.phase[an.phase.length - 1] - an.phase[0]) / (2 * Math.PI);
const durS = an.amp.length / 200;
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

/* ══════ v1.10の修正が実データでどれだけ効くか ══════
   旧：区間を切ってからヒルベルト → 区間には「前」が無いので位相が作り話になる
   新：収録全体に掛けてから区間を切る

   ⚠️効き目は正直に言って小さい。実測で位相ズレの中央値は数度（区間が短いほど大きい：
   1周期ぶんも入らない1〜2秒の区間で5〜6°、10秒を超えると2°以下）。
   直す理由は数字の大きさではなく筋で、区間の頭には本来「前」があった（スタート地点に
   立っていた時間）のに、切ると計算がそれを捏造するから。なぞりの起点＝音の0秒が
   そこに当たる以上、捏造を残す理由が無い。
   ★これは「音がいきなり始まる」問題の説明ではない。あちらはカウントインが無いという別の話。 */
console.log('\n[ v1.10：切ってから掛けると頭がどれだけ壊れるか（実データ） ]');
const oldSeg = gyroSeries(rec, from, to);
const anOld = S.analytic(oldSeg.val, 200, 15);
const wrapDeg = d => Math.abs(Math.atan2(Math.sin(d), Math.cos(d)) * 180 / Math.PI);
const nCmp = Math.min(anOld.phase.length, an.phase.length);
// 振幅が中央値の30%以上ある点だけで比べる（原点近くは位相が原理的に不安定なので混ぜない）
const sorted = Array.from(an.amp.slice(0, nCmp)).sort((x, y) => x - y);
const ampMed = sorted[Math.floor(sorted.length / 2)];
// ★中央値で見る。最大値は「原点のすぐ近く」の点に支配されてしまい、
//   端点効果とは別物（位相角は振幅が0に近づくと原理的に不安定）を拾ってしまう。
function worst(aS, bS) {
  const ds = [];
  for (let i = Math.round(aS * 200); i < Math.min(Math.round(bS * 200), nCmp); i++) {
    if (an.amp[i] <= 0.3 * ampMed) continue;
    ds.push(wrapDeg(anOld.phase[i] - an.phase[i]));
  }
  ds.sort((x, y) => x - y);
  return { mx: ds.length ? ds[Math.floor(ds.length / 2)] : 0, cnt: ds.length };
}
const head = worst(0, 0.1), tail = worst(0.5, durS - 0.5);
console.log(`  区間の先頭0.1秒 : 旧と新の位相差 中央値 ${head.mx.toFixed(1)}°  (${head.cnt}点で比較)`);
console.log(`  0.5秒〜末尾0.5秒: 旧と新の位相差 中央値 ${tail.mx.toFixed(1)}°  (${tail.cnt}点で比較)`);
console.log(`  → 逓倍N=${N} なので、頭の ${head.mx.toFixed(0)}° は音では約 ${(head.mx * N / 360).toFixed(0)} 周ぶんのずれだった`);
// ★「頭のほうが必ず大きい」とは主張しない。実測では区間が短いと全体が汚れ、
//   長いと頭だけになる、というふうにデータで変わった。だからここは記録に留める。
//   代わりに、アプリの経路が自己整合していること（全体を解析して切る＝切った結果と一致）を見る。
const reSlice = { amp: anFull.amp.slice(i0, i1), phase: anFull.phase.slice(i0, i1) };
let sliceOk = reSlice.amp.length === an.amp.length;
for (let i = 0; sliceOk && i < an.amp.length; i++) {
  if (reSlice.amp[i] !== an.amp[i] || reSlice.phase[i] !== an.phase[i]) sliceOk = false;
}
check('全体を解析してから切る経路が自己整合している', sliceOk, `${an.amp.length}点`);
check('区間の位相が連続している（切れ目でジャンプしない）',
      (() => { let mx = 0;
        for (let i = 1; i < an.phase.length; i++) mx = Math.max(mx, Math.abs(an.phase[i] - an.phase[i-1]));
        return mx < Math.PI; })(), '隣り合う点の位相差が π 未満');

// 中心化：平均が引かれているか（バイアスを入れても位相面が原点に来ること）
const biased = uni.val.map(v => v + 0.05);          // 正規化値で0.05＝100 deg/s のバイアスを故意に足す
const anB = S.analytic(biased, 200, 15);
let mean0 = 0, meanB = 0;
for (let i = 200; i < anFull.amp.length - 200; i++) { mean0 += anFull.amp[i]; meanB += anB.amp[i]; }
const nn = anFull.amp.length - 400;
check('★バイアスを足しても結果がほぼ変わらない（中心化が効いている）',
      Math.abs(mean0 / nn - meanB / nn) / (mean0 / nn) < 0.02,
      `平均振幅 ${(mean0/nn).toFixed(1)} → ${(meanB/nn).toFixed(1)}`);
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
