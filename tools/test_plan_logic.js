// 条件の進行係（v1.6）を、ブラウザなしで動かして検算する。
// index.html の本体スクリプトをそのまま取り出し、最小限のDOMを偽物で与えて実行する。
// ＝「アプリの中の本物のコード」を試すので、書き写しのズレが起きない。
//
//   node tools/test_plan_logic.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = html.match(/<script>([\s\S]*?)<\/script>/g).map(s => s.replace(/^<script>|<\/script>$/g, ''));
const body = scripts[scripts.length - 1];   // 本体（2つめのインラインscript）

// ---- 偽のDOM ----
function mkEl(id) {
  return {
    id, textContent: '', className: '', value: '', checked: false, disabled: false,
    innerHTML: '', style: {}, onclick: null, oninput: null, onchange: null,
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {},
  };
}
const els = new Map();
const document = {
  getElementById(id) { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); },
  createElement() { return mkEl('new'); },
  addEventListener() {}, visibilityState: 'visible',
};
const sandbox = {
  document,
  window: { addEventListener() {}, isSecureContext: true, __logLine(m) { sandbox.__logs.push(m); } },
  navigator: {},                    // bluetooth / vibrate / wakeLock いずれも無し
  performance: { now: () => Date.now() },
  requestAnimationFrame() {},       // ライブ表示のループは回さない
  setTimeout, clearInterval, setInterval, console, Date, Math, JSON, Object, Array, String, Number, isFinite,
  Blob: class { constructor() {} }, URL: { createObjectURL: () => 'blob:x' },
  Sonify: require(path.join(root, 'js/sonify.js')),
  __logs: [],
};
sandbox.window.__logLine = m => sandbox.__logs.push(m);
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// 内部の変数に触れるための覗き窓を末尾に足す
const exposed = body + `
;globalThis.__T = {
  get plan(){return plan}, set plan(v){plan=v},
  get planIdx(){return planIdx}, set planIdx(v){planIdx=v},
  get markers(){return markers}, set markers(v){markers=v},
  set recording(v){recording=v}, set recStart(v){recStart=v}, set recEnd(v){recEnd=v},
  set sonSet(v){sonSet=v},
  makePlan, currentCond, renderPlan, addMarker, pairedRanges, COND, feet,
  get feltTarget(){return feltTarget},
};`;
vm.runInContext(exposed, sandbox);
const T = sandbox.__T;
const $ = id => document.getElementById(id);

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? '  OK   ' : '  NG   ') + name + (detail !== undefined ? '   ' + detail : ''));
  if (!ok) fail++;
}

// ================= 1. 順序のつくり方 =================
console.log('[ ブロックランダム化 ]');
const p = T.makePlan(3, true);
check('本数 = 3ブロック × 4条件', p.length === 12, p.length + '本');
let blocksOk = true;
for (let b = 1; b <= 3; b++) {
  const inB = p.filter(x => x.block === b).map(x => x.cond).sort().join(',');
  if (inB !== 'frozen,metronome,phase,silent') blocksOk = false;
}
check('各ブロックに全条件がちょうど1回ずつ', blocksOk);
const p2 = T.makePlan(2, false);
check('無音を外すと3条件', p2.length === 6 && !p2.some(x => x.cond === 'silent'), p2.length + '本');
// 順序が固定されていないこと（20回引いて全部同じ並びなら乱れていない）
const seen = new Set();
for (let i = 0; i < 20; i++) seen.add(T.makePlan(1, true).map(x => x.cond).join(','));
check('引き直すと順序が変わる', seen.size > 1, seen.size + '通り');

// ================= 2. 紫→橙で条件が1つ進む =================
console.log('\n[ 進行：紫を押すだけで条件が切り替わる ]');
T.plan = T.makePlan(2, true);
T.planIdx = 0;
T.markers = [];
T.recording = true; T.recStart = Date.now();
T.sonSet = {};                         // 音は作った（種類は空＝鳴らせない）状態
const order = T.plan.map(x => x.cond);

T.addMarker();                         // 紫（1本目）
check('紫で条件が付く', T.markers[0].condition === order[0], T.markers[0].condition);
check('その条件の音が無いので鳴っていない記録', T.markers[0].sound_playing === null);
check('紫の時点では進行は進まない', T.planIdx === 0, 'planIdx=' + T.planIdx);
T.addMarker();                         // 橙（1本目おわり）
check('橙で1つ進む', T.planIdx === 1, 'planIdx=' + T.planIdx);
check('1本目が done', T.plan[0].done === true);
check('区間番号が残る', T.plan[0].range_index === 1, '区間' + T.plan[0].range_index);
check('一言の書き込み先が1本目', T.feltTarget === 0);

T.addMarker(); T.addMarker();          // 2本目
check('2本目は順序の2番目', T.markers[2].condition === order[1], T.markers[2].condition);
check('2本進んだ', T.planIdx === 2);
check('区間番号が2になる', T.plan[1].range_index === 2);

// ================= 3. 取り消しで進行も戻る =================
console.log('\n[ 取り消し（アプリの ↩ ボタンそのものを呼ぶ） ]');
$('undo').onclick.call($('undo'));     // 橙を取り消す＝直前の1本をやり直す
check('やり直すと planIdx が戻る', T.planIdx === 1, 'planIdx=' + T.planIdx);
check('done が外れる', T.plan[1].done === false);
check('区間番号も消える', T.plan[1].range_index === null);
check('やり直した条件は変わらない', T.plan[1].cond === order[1], T.plan[1].cond);
check('一言の書き込み先が外れる', T.feltTarget === null);
$('undo').onclick.call($('undo'));     // さらに紫も取り消す（開始マーカー＝進行は動かない）
check('紫の取り消しでは進行は動かない', T.planIdx === 1, 'planIdx=' + T.planIdx);
check('マーカーが2本ぶんに戻る', T.markers.length === 2, T.markers.length + '個');

// ================= 4. 体感の一言 =================
console.log('\n[ 体感の一言 ]');
T.addMarker(); T.addMarker();          // 2本目をやり直して閉じる（feltTarget が付く）
check('やり直した結果 planIdx=2', T.planIdx === 2, 'planIdx=' + T.planIdx);
$('felt').value = '  ３歩目が軽かった  ';
$('felt').oninput.call($('felt'));
check('前後の空白を落として保存', T.plan[T.feltTarget] && T.plan[T.feltTarget].felt === '３歩目が軽かった',
      JSON.stringify(T.plan[T.feltTarget] && T.plan[T.feltTarget].felt));

// ================= 5. 解析側に渡る形 =================
console.log('\n[ ranges に条件が入るか ]');
T.recEnd = Date.now();
const rg = T.pairedRanges();
check('区間の数', rg.length >= 2, rg.length + '本');
check('condition が入っている', rg[0].condition === order[0], rg[0].condition);
check('sound_playing は null（その音が無かった）', rg[0].sound_playing === null);
check('条件が区間ごとに違う', rg[0].condition !== rg[1].condition,
      rg[0].condition + ' / ' + rg[1].condition);

// ================= 6. 音があるときは鳴る =================
console.log('\n[ 音を用意した場合 ]');
// startSound は AudioContext を触るので、音の入れ物だけ偽物にして「選ばれた種類」を見る
let played = null;
sandbox.eval = undefined;
T.markers = []; T.planIdx = 0;
T.plan = [{ cond: 'phase', block: 1, done: false, range_index: null },
          { cond: 'silent', block: 1, done: false, range_index: null }];
vm.runInContext('startSound = function(k){ globalThis.__played = k; return {}; };', sandbox);
T.sonSet = { phase: {}, metronome: {}, frozen: {} };
T.addMarker();
check('phase 条件で phase の音が選ばれる', sandbox.__played === 'phase', String(sandbox.__played));
check('sound_playing に実際の音が残る', T.markers[0].sound_playing === 'phase');
T.addMarker();
sandbox.__played = null;
T.addMarker();
check('silent 条件では鳴らさない', sandbox.__played === null, String(sandbox.__played));
check('silent の sound_playing は null', T.markers[2].sound_playing === null);

// ================= 7. 課題の誤差（踏切位置のズレ） =================
console.log('\n[ 課題の誤差が数値で残るか ]');
T.plan = T.makePlan(1, true); T.planIdx = 0; T.markers = []; T.sonSet = {};
T.recording = true; T.recStart = Date.now();
T.addMarker(); T.addMarker();                 // 1本やって閉じる
$('taskerr').value = '-7.5';
$('taskerr').oninput.call($('taskerr'));
check('負の値が数値で入る', T.plan[0].task_error_cm === -7.5, T.plan[0].task_error_cm);
$('felt').value = '詰まった';
$('felt').oninput.call($('felt'));
check('一言と併存する', T.plan[0].felt === '詰まった' && T.plan[0].task_error_cm === -7.5);
$('taskerr').value = 'abc';
$('taskerr').oninput.call($('taskerr'));
check('数値でなければ null', T.plan[0].task_error_cm === null, String(T.plan[0].task_error_cm));
$('taskerr').value = '3';
$('taskerr').oninput.call($('taskerr'));
T.addMarker();                                 // 次の紫でクリアされる
check('次の試技に入ると入力欄が空になる', $('taskerr').value === '' && $('felt').value === '');
check('前の試技の値は残っている', T.plan[0].task_error_cm === 3);
T.addMarker(); T.recEnd = Date.now();
const rr = T.pairedRanges();
check('ranges に task_error_cm が載る', rr[0].task_error_cm === 3, rr[0].task_error_cm);
check('未入力の試技は null', rr[1].task_error_cm === null, String(rr[1].task_error_cm));
// ================= 8. v1.6の不具合の再発防止 =================
// 進行係を使っているとき、体感の一言が ranges[] に載っていなかった。
// 解析側は ranges を見るので、plan にだけ書いていると届かない。
console.log('\n[ 進行係ありでも ranges に届くか（v1.6の不具合の再発防止） ]');
T.plan = T.makePlan(1, false); T.planIdx = 0; T.markers = []; T.sonSet = {};
T.recording = true; T.recStart = Date.now();
T.addMarker(); T.addMarker();
$('felt').value = '軽かった'; $('felt').oninput.call($('felt'));
$('taskerr').value = '2.5'; $('taskerr').oninput.call($('taskerr'));
T.recEnd = Date.now();
const r8 = T.pairedRanges();
check('進行係ありでも ranges[].felt が入る', r8[0].felt === '軽かった', JSON.stringify(r8[0].felt));
check('進行係ありでも ranges[].task_error_cm が入る', r8[0].task_error_cm === 2.5, r8[0].task_error_cm);
check('plan 側にも残っている（画面表示用）', T.plan[0].felt === '軽かった' && T.plan[0].task_error_cm === 2.5);

// ================= 9. 試技A（音を作るための録り）が条件を食べないか =================
console.log('\n[ 試技Aが実験の1本目になってしまわないか ]');
T.plan = T.makePlan(2, true); T.planIdx = 0; T.markers = []; T.sonSet = null;  // 音はまだ無い
T.recording = true; T.recStart = Date.now();
const cond0 = T.plan[0].cond;
T.addMarker(); T.addMarker();          // ← これが「試技A」。音を作るために録るだけ
check('Aの区間に条件が付いていない', T.markers[0].condition === null, String(T.markers[0].condition));
check('★Aで進行が進んでいない', T.planIdx === 0, 'planIdx=' + T.planIdx);
check('1本目の条件がまだ残っている', T.plan[0].done === false && T.plan[0].cond === cond0);

console.log('\n' + (fail === 0 ? '✓ すべて通過' : '✗ ' + fail + ' 件 失敗'));
if (sandbox.__logs.length) console.log('\n(アプリのログ)\n  ' + sandbox.__logs.join('\n  '));
process.exit(fail === 0 ? 0 : 1);
