// ZIP書き出しの検算。実際に unzip で開けることまで確かめる。
const fs=require('fs'), os=require('os'), path=require('path'), {execSync}=require('child_process');
const Zip=require('../js/zip.js');

// CRC32が既知の値と合うか（"123456789" の CRC32 = 0xCBF43926）
const enc=new TextEncoder();
const c=Zip.crc32(enc.encode('123456789'));
console.log(`CRC32("123456789") = 0x${c.toString(16).toUpperCase()}  ${c===0xCBF43926?'OK':'NG（期待 0xCBF43926）'}`);

// 実データに近い中身で作る
const csv='timestamp,acc_x,gyro_x\n'+Array.from({length:5000},(_,i)=>`${1785400000000+i*5},0.01,${Math.sin(i/30).toFixed(6)}`).join('\n')+'\n';
const meta=JSON.stringify({label:'run',ranges:[{index:1,condition:'phase'}]},null,2);
const bin=new Uint8Array(3000); for(let i=0;i<bin.length;i++) bin[i]=i&255;   // wav代わり
const files=[
  Zip.textFile('run_left_sensor.csv', csv),
  Zip.textFile('run_meta.json', meta),
  {name:'run_sound_phase.wav', bytes:bin},
  // ★日本語のファイル名は入れない。アプリ側は label を [^\w-] で潰すのでASCIIのみ。
  //   macOS付属の unzip はUTF-8フラグを尊重せず名前を化かすので、そこに寄りかからない。
];
const out=Zip.zip(files);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ziptest-'));
const zp=path.join(dir,'t.zip');
fs.writeFileSync(zp, out);
console.log(`ZIP ${(out.length/1024).toFixed(1)}KB（元の合計 ${((csv.length+meta.length+bin.length+7)/1024).toFixed(1)}KB）`);

let ok=true;
try { execSync(`unzip -t ${zp}`,{stdio:'pipe'}); console.log('unzip -t（整合性）: OK'); }
catch(e){ console.log('unzip -t: NG\n'+e.stdout); ok=false; }
try {
  execSync(`unzip -o -q ${zp} -d ${dir}/x`);
  const back=fs.readFileSync(path.join(dir,'x','run_left_sensor.csv'),'utf8');
  console.log('CSVが元と一致:', back===csv ? 'OK' : 'NG');
  const b2=fs.readFileSync(path.join(dir,'x','run_sound_phase.wav'));
  console.log('バイナリが元と一致:', Buffer.compare(b2, Buffer.from(bin))===0 ? 'OK' : 'NG');
  const j=JSON.parse(fs.readFileSync(path.join(dir,'x','run_meta.json'),'utf8'));
  console.log('JSONとして読める:', j.ranges[0].condition==='phase' ? 'OK':'NG');
  console.log('ファイル数:', fs.readdirSync(path.join(dir,'x')).length === 3 ? 'OK（3件）':'NG');
  if(back!==csv||Buffer.compare(b2,Buffer.from(bin))!==0) ok=false;
} catch(e){ console.log('展開に失敗:', e.message); ok=false; }
console.log(ok?'\n✓ すべて通過':'\n✗ 失敗'); process.exit(ok?0:1);
