// 条件の進行係と保存の見張り（v1.9）を、ブラウザなしで動かして検算する。
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
    // 保存リンクの検査に使う
    listeners: {},
    addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); },
    click() { (this.listeners.click || []).forEach(fn => fn()); },
  };
}
const els = new Map();
const document = {
  getElementById(id) { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); },
  createElement() { return mkEl('new'); },
  addEventListener() {}, visibilityState: 'visible',
};
let confirmAnswer = true, confirmCalls = 0;
const sandbox = {
  document,
  confirm(msg) { confirmCalls++; sandbox.__lastConfirm = msg; return confirmAnswer; },
  Uint8Array, TextEncoder, Promise, Set, Error, Infinity,
  window: { addEventListener() {}, isSecureContext: true, __logLine(m) { sandbox.__logs.push(m); } },
  navigator: {},                    // bluetooth / vibrate / wakeLock いずれも無し
  performance: { now: () => Date.now() },
  requestAnimationFrame() {},       // ライブ表示のループは回さない
  setTimeout, clearInterval, setInterval, console, Date, Math, JSON, Object, Array, String, Number, isFinite,
  // ★中身の取れるBlob。保存経路（buildDownloads → ZIP）をそのまま動かすために要る
  Blob: class {
    constructor(parts) {
      const enc = new TextEncoder();
      const chunks = (parts || []).map(x => (x instanceof Uint8Array) ? x : enc.encode(String(x)));
      const n = chunks.reduce((t, c) => t + c.length, 0);
      this._b = new Uint8Array(n);
      let o = 0; for (const c of chunks) { this._b.set(c, o); o += c.length; }
      this.size = n;
    }
    arrayBuffer() { return Promise.resolve(this._b.buffer.slice(this._b.byteOffset, this._b.byteOffset + this._b.length)); }
  },
  URL: { createObjectURL: () => 'blob:x' },
  Zip: require(path.join(root, 'js/zip.js')),
  TextEncoder, Uint8Array, Promise, Set, Infinity, ArrayBuffer,
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
  dataAgeMs, dataStale, STALE_MS, OVERRIDE_MS,
  get unsaved(){return unsaved}, set unsaved(v){unsaved=v},
  get pendingFiles(){return pendingFiles}, set pendingFiles(v){pendingFiles=v},
  savedNames, renderUnsaved, checkAllSaved,
  get staleWarnedAt(){return staleWarnedAt}, set staleWarnedAt(v){staleWarnedAt=v},
  buildDownloads, mkLink, get zipName(){return zipName},
  set recEnd2(v){recEnd=v},
};`;
vm.runInContext(exposed, sandbox);
const T = sandbox.__T;
const $ = id => document.getElementById(id);

// ★v1.9：紫はデータが来ていないと止まる。既存のテストは「来ている」前提なので、
//   押す直前にセンサの受信時刻を今にしておく（実験中の正常な状態を再現する）。
function fresh() {
  T.feet.L.connected = true; T.feet.L.lastRecvMs = Date.now();
}
function mark() { fresh(); T.addMarker(); }

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

mark();                         // 紫（1本目）
check('紫で条件が付く', T.markers[0].condition === order[0], T.markers[0].condition);
check('その条件の音が無いので鳴っていない記録', T.markers[0].sound_playing === null);
check('紫の時点では進行は進まない', T.planIdx === 0, 'planIdx=' + T.planIdx);
mark();                         // 橙（1本目おわり）
check('橙で1つ進む', T.planIdx === 1, 'planIdx=' + T.planIdx);
check('1本目が done', T.plan[0].done === true);
check('区間番号が残る', T.plan[0].range_index === 1, '区間' + T.plan[0].range_index);
check('一言の書き込み先が1本目', T.feltTarget === 0);

mark(); mark();          // 2本目
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
mark(); mark();          // 2本目をやり直して閉じる（feltTarget が付く）
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
mark();
check('phase 条件で phase の音が選ばれる', sandbox.__played === 'phase', String(sandbox.__played));
check('sound_playing に実際の音が残る', T.markers[0].sound_playing === 'phase');
mark();
sandbox.__played = null;
mark();
check('silent 条件では鳴らさない', sandbox.__played === null, String(sandbox.__played));
check('silent の sound_playing は null', T.markers[2].sound_playing === null);

// ================= 7. 課題の誤差（踏切位置のズレ） =================
console.log('\n[ 課題の誤差が数値で残るか ]');
T.plan = T.makePlan(1, true); T.planIdx = 0; T.markers = []; T.sonSet = {};
T.recording = true; T.recStart = Date.now();
mark(); mark();                 // 1本やって閉じる
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
mark();                                 // 次の紫でクリアされる
check('次の試技に入ると入力欄が空になる', $('taskerr').value === '' && $('felt').value === '');
check('前の試技の値は残っている', T.plan[0].task_error_cm === 3);
mark(); T.recEnd = Date.now();
const rr = T.pairedRanges();
check('ranges に task_error_cm が載る', rr[0].task_error_cm === 3, rr[0].task_error_cm);
check('未入力の試技は null', rr[1].task_error_cm === null, String(rr[1].task_error_cm));
// ================= 8. v1.6の不具合の再発防止 =================
// 進行係を使っているとき、体感の一言が ranges[] に載っていなかった。
// 解析側は ranges を見るので、plan にだけ書いていると届かない。
console.log('\n[ 進行係ありでも ranges に届くか（v1.6の不具合の再発防止） ]');
T.plan = T.makePlan(1, false); T.planIdx = 0; T.markers = []; T.sonSet = {};
T.recording = true; T.recStart = Date.now();
mark(); mark();
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
mark(); mark();          // ← これが「試技A」。音を作るために録るだけ
check('Aの区間に条件が付いていない', T.markers[0].condition === null, String(T.markers[0].condition));
check('★Aで進行が進んでいない', T.planIdx === 0, 'planIdx=' + T.planIdx);
check('1本目の条件がまだ残っている', T.plan[0].done === false && T.plan[0].cond === cond0);

// ================= 10. データが来ていないと紫が押せない（v1.9・③） =================
// 2026-07-30の3本目が0行だった。BLEが落ちていても画面は「収録中」に見えるので、
// 走り終わるまで気づけなかった。押す前に止めるのがここ。
console.log('\n[ データが来ていないと紫を止める（v1.9） ]');
T.plan = null; T.planIdx = 0; T.markers = []; T.sonSet = {};
T.recording = true; T.recStart = Date.now(); T.staleWarnedAt = 0;
T.feet.L.connected = false; T.feet.R.connected = false;
check('未接続なら鮮度は null', T.dataAgeMs() === null, String(T.dataAgeMs()));
check('未接続は「止まっている」', T.dataStale() === true);
T.addMarker();                                   // fresh() を通さず素で押す
check('★未接続では紫が入らない', T.markers.length === 0, T.markers.length + '個');
// ★猶予をリセットしてから次の場面に入る。
//   直前の警告から OVERRIDE_MS 以内だと「押し直し」と見なされて通るのが正しい挙動なので、
//   別の場面を試すときは持ち越さない。
T.markers = []; T.staleWarnedAt = 0;
T.feet.L.connected = true; T.feet.L.lastRecvMs = Date.now() - (T.STALE_MS + 500);
check('古いサンプルも「止まっている」', T.dataStale() === true, T.dataAgeMs() + 'ms');
T.addMarker();
check('★古いままでは紫が入らない', T.markers.length === 0, T.markers.length + '個');
// 締め出さない：警告の直後にもう一度押したら通る（実験を止めないため）
T.addMarker();
check('もう一度押せば通る（締め出さない）', T.markers.length === 1, T.markers.length + '個');
check('通した区間には古さが数値で残る',
      typeof T.markers[0].data_age_ms === 'number' && T.markers[0].data_age_ms > T.STALE_MS,
      String(T.markers[0].data_age_ms));
// 橙は止めない（止めると区間の終わりを失う）
T.addMarker();
check('橙はデータが古くても止めない', T.markers.length === 2 && T.markers[1].kind === 'end');
// データが来ていれば1回で通る
T.markers = []; T.staleWarnedAt = 0;
fresh(); T.addMarker();
check('データが来ていれば1回で通る', T.markers.length === 1, T.markers.length + '個');
check('鮮度が小さい値で残る', T.markers[0].data_age_ms !== null && T.markers[0].data_age_ms < T.STALE_MS,
      String(T.markers[0].data_age_ms));

// ================= 11. 未保存の見張り（v1.9・②） =================
// 2026-07-30に5本ぶん失った。原因は「保存ボタンを押していない」。
console.log('\n[ 未保存のまま次の収録を始めさせない（v1.9） ]');
T.unsaved = true;
T.pendingFiles = [{ name: 'a.csv' }, { name: 'b.json' }];
T.savedNames.clear();
T.renderUnsaved();
check('赤いバナーが出る', $('unsaved').style.display === 'block');
check('残りファイル数が出る', /残り 2 ファイル/.test($('unsaved').textContent), $('unsaved').textContent.split('\n')[0]);
T.savedNames.add('a.csv'); T.checkAllSaved();
check('1つ保存しただけでは解除されない', T.unsaved === true);
check('残りが減る', /残り 1 ファイル/.test($('unsaved').textContent));
T.savedNames.add('b.json'); T.checkAllSaved();
check('全部保存したら解除される', T.unsaved === false);
check('バナーが消える', $('unsaved').style.display === 'none');

// 未保存のまま収録開始を押したときの分岐（アプリの ● 収録開始 そのものを呼ぶ）
T.recording = false;
T.unsaved = true; T.pendingFiles = [{ name: 'a.csv' }]; T.savedNames.clear();
confirmCalls = 0; confirmAnswer = false;
$('rec').onclick.call($('rec'));
check('★未保存なら確認を出す', confirmCalls === 1, confirmCalls + '回');
check('いいえ＝収録は始まらない', T.unsaved === true && $('rec').style.display !== 'none');
confirmAnswer = true;
$('rec').onclick.call($('rec'));
check('はい＝捨てて進む', T.unsaved === false && T.pendingFiles.length === 0);
// 保存済みなら黙って始まる
T.recording = false; $('rec').style.display = '';
confirmCalls = 0;
$('rec').onclick.call($('rec'));
check('保存済みなら確認は出ない', confirmCalls === 0, confirmCalls + '回');

// ================= 12. 保存経路を通しで（v1.9・①） =================
// 一番失いたくないところなので、buildDownloads から実際にZIPを組むところまで動かす。
// 2026-07-30に失ったのは「押していない」からだが、押しても落ちなければ同じことになる。
console.log('\n[ 一括保存（ZIP）を通しで動かす（v1.9） ]');
T.plan = T.makePlan(1, false); T.planIdx = 0; T.markers = []; T.sonSet = null;
T.recording = true; T.recStart = Date.now() - 5000;
T.feet.L.connected = true;
T.feet.L.rec = Array.from({ length: 400 }, (_, i) =>
  (1785400000000 + i * 5) + ',0.01,0.02,0.98,' + (i / 100) + ',0,0,1,2,3,32768');
mark(); mark();
T.recording = false; T.recEnd2 = Date.now();
$('label').value = 'run1';
T.buildDownloads();
check('保存すべきファイルが並ぶ', T.pendingFiles.length >= 2, T.pendingFiles.length + '件');
check('左足CSVが入る', T.pendingFiles.some(f => /_left_sensor\.csv$/.test(f.name)),
      T.pendingFiles.map(f => f.name).join(' '));
check('meta.json が入る', T.pendingFiles.some(f => /_meta\.json$/.test(f.name)));
check('★中身のある収録は未保存になる', T.unsaved === true);
check('ZIP名がラベル入り', /^run1_\d{14}\.zip$/.test(T.zipName), T.zipName);
check('緑のボタンが出る', $('zipwrap').style.display === '');

// 実際にZIPを組んで、展開できることまで確かめる
(async () => {
  const files = [];
  for (const f of T.pendingFiles) files.push({ name: f.name, bytes: new Uint8Array(await f.blob.arrayBuffer()) });
  const bytes = require(path.join(root, 'js/zip.js')).zip(files);
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  const zp = path.join(dir, T.zipName);
  fs.writeFileSync(zp, bytes);
  const { execSync } = require('child_process');
  let ok = true;
  try { execSync('unzip -t ' + JSON.stringify(zp), { stdio: 'pipe' }); } catch (e) { ok = false; }
  check('組んだZIPが開ける', ok, (bytes.length / 1024).toFixed(0) + 'KB');
  execSync('unzip -o -q ' + JSON.stringify(zp) + ' -d ' + JSON.stringify(dir + '/x'));
  const csvName = T.pendingFiles.find(f => /_left_sensor\.csv$/.test(f.name)).name;
  const back = fs.readFileSync(path.join(dir, 'x', csvName), 'utf8').trim().split('\n');
  check('CSVの行数が合う（見出し+400行）', back.length === 401, back.length + '行');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'x',
    T.pendingFiles.find(f => /_meta\.json$/.test(f.name)).name), 'utf8'));
  check('metaのrangesが読める', m.ranges.length === 1, m.ranges.length + '本');
  check('★区間に data_age_ms が載る', typeof m.markers[0].data_age_ms === 'number',
        String(m.markers[0].data_age_ms));

  console.log('\n' + (fail === 0 ? '✓ すべて通過' : '✗ ' + fail + ' 件 失敗'));
  if (sandbox.__logs.length) console.log('\n(アプリのログ)\n  ' + sandbox.__logs.join('\n  '));
  process.exit(fail === 0 ? 0 : 1);
})();
// ↑ 結果の表示と process.exit は上の async の中で行う（同期で exit すると後半が飛ぶ）
