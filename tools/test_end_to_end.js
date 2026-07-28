// 実データで「区間を切り出す→音を作る」まで通す。ブラウザに入れる前の検証。
const fs = require('fs');
const S = require('../js/sonify.js');
const meta = JSON.parse(fs.readFileSync('/Users/saras/Library/CloudStorage/OneDrive-Personal/run_20260728152847_meta.json','utf8'));
const lines = fs.readFileSync('/Users/saras/Library/CloudStorage/OneDrive-Personal/run_20260728152847_left_sensor.csv','utf8').trim().split('\n');
const rec = lines.slice(1);

// アプリの gyroSeries と同じ手順
function gyroSeries(rows, fromTs, toTs) {
  const ts=[], gx=[], seen=new Map();
  for (const line of rows) {
    const c=line.split(','); const t=+c[0];
    const k=seen.get(t)||0; seen.set(t,k+1);
    ts.push(t+k*5); gx.push(+c[4]);
  }
  const val=[]; let i=0;
  for (let x=fromTs; x<=toTs; x+=5) {
    while (i<ts.length-2 && ts[i+1]<x) i++;
    const span=(ts[i+1]-ts[i])||1, f=(x-ts[i])/span;
    val.push(gx[i]+(gx[i+1]-gx[i])*f);
  }
  return val;
}

const m0=meta.markers[0], m1=meta.markers[1];
const from=m0.sensor_ts.left, to=m1.sensor_ts.left;
console.log(`区間: ${m0.t_s.toFixed(2)}〜${m1.t_s.toFixed(2)}s  (${((to-from)/1000).toFixed(2)}s)`);

const gyro = gyroSeries(rec, from, to);
console.log(`サンプル数 ${gyro.length}  (200Hzなら ${(gyro.length/200).toFixed(2)}s 相当)`);

const t0=Date.now();
const an = S.analytic(gyro, 200, 15);
const samples = S.renderPhaseSound(an.amp, an.phase, 200, 44100, 200);
const ms=Date.now()-t0;

const laps=Math.abs(an.phase[an.phase.length-1]-an.phase[0])/(2*Math.PI);
let peak=0, sil=0;
for (const v of samples){ const a=Math.abs(v); if(a>peak)peak=a; if(a<0.01)sil++; }
console.log(`位相 ${laps.toFixed(2)}周  1周 ${(gyro.length/200/laps).toFixed(3)}s → 中心 ${Math.round(200/(gyro.length/200/laps))}Hz`);
console.log(`音: ${samples.length}サンプル = ${(samples.length/44100).toFixed(2)}s  ピーク ${peak.toFixed(2)}  無音率 ${(100*sil/samples.length).toFixed(1)}%`);
console.log(`生成にかかった時間: ${ms}ms  ← スマホでもこの程度なら試技の合間に十分`);

// wav書き出しの検証（Blobはnodeに無いので長さだけ確認）
const wavLen = 44 + samples.length*2;
console.log(`wavの大きさ: ${(wavLen/1024/1024).toFixed(2)} MB`);
let nan=0; for (const v of samples) if (!isFinite(v)) nan++;
console.log(`NaN/Inf: ${nan}  ${nan?'✗':'✓'}`);
