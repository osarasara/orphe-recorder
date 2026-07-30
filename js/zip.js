/* 最小のZIP書き出し（無圧縮・store方式）。依存なし。
 *
 * なぜZIPにするか：
 *   1回の収録で保存するファイルが5〜6個（左CSV・右CSV・meta・wav×3）あり、
 *   走った直後にスマホでリンクを1つずつタップする作りだった。
 *   2026-07-30の実験で実際に保存し忘れて、5本ぶんのデータを失った。
 *   ブラウザは複数ファイルの連続ダウンロードをブロックすることがあるので、
 *   「1ファイルにまとめて1タップ」がいちばん確実。
 *
 * 無圧縮なのは、CRC32だけで完結して実装が短く、壊れる余地が少ないから。
 * CSVとwavが主なので圧縮率を捨てても実用上の問題は小さい。
 *
 * ⚠️ ファイル名はASCIIに限る。UTF-8フラグは立てているが、macOS付属の unzip は
 *    それを尊重せず名前を化かす（実測）。アプリ側は label を [^\w-] で潰すので
 *    日本語は入らない。ここに寄りかからないこと。
 */
(function (global) {
  'use strict';

  // ---- CRC32（テーブルは初回に作る） ----
  let TABLE = null;
  function crcTable() {
    if (TABLE) return TABLE;
    TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      TABLE[i] = c >>> 0;
    }
    return TABLE;
  }
  function crc32(bytes) {
    const t = crcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const enc = new TextEncoder();

  /** files: [{name, bytes:Uint8Array}] → Uint8Array（ZIPの中身） */
  function zip(files) {
    const parts = [];      // 出力を順に積む
    const central = [];    // 中央ディレクトリの断片
    let offset = 0;

    const u16 = n => new Uint8Array([n & 255, (n >>> 8) & 255]);
    const u32 = n => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
    const push = (arr, a) => { arr.push(a); return a.length; };

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const crc = crc32(f.bytes);
      const size = f.bytes.length;
      // ローカルファイルヘッダ
      let n = 0;
      n += push(parts, u32(0x04034b50));
      n += push(parts, u16(20));            // version needed
      n += push(parts, u16(0x0800));        // flag: ファイル名はUTF-8
      n += push(parts, u16(0));             // method: 0 = store（無圧縮）
      n += push(parts, u16(0));             // 時刻（使わない。Date.nowに依存しない）
      n += push(parts, u16(0));             // 日付
      n += push(parts, u32(crc));
      n += push(parts, u32(size));          // 圧縮後サイズ＝元サイズ
      n += push(parts, u32(size));
      n += push(parts, u16(nameBytes.length));
      n += push(parts, u16(0));             // extra field なし
      n += push(parts, nameBytes);
      n += push(parts, f.bytes);

      // 中央ディレクトリ
      push(central, u32(0x02014b50));
      push(central, u16(20));               // version made by
      push(central, u16(20));               // version needed
      push(central, u16(0x0800));
      push(central, u16(0));
      push(central, u16(0));
      push(central, u16(0));
      push(central, u32(crc));
      push(central, u32(size));
      push(central, u32(size));
      push(central, u16(nameBytes.length));
      push(central, u16(0));                // extra
      push(central, u16(0));                // comment
      push(central, u16(0));                // disk number
      push(central, u16(0));                // internal attrs
      push(central, u32(0));                // external attrs
      push(central, u32(offset));           // ローカルヘッダの位置
      push(central, nameBytes);

      offset += n;
    }

    const centralSize = central.reduce((s, a) => s + a.length, 0);
    const eocd = [];
    push(eocd, u32(0x06054b50));
    push(eocd, u16(0)); push(eocd, u16(0));
    push(eocd, u16(files.length)); push(eocd, u16(files.length));
    push(eocd, u32(centralSize));
    push(eocd, u32(offset));
    push(eocd, u16(0));                     // comment length

    const all = parts.concat(central, eocd);
    const total = all.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  /** 文字列またはBlobを混ぜて渡せる形。Blobは呼び出し側で bytes にしてから渡す */
  function textFile(name, text) { return { name, bytes: enc.encode(text) }; }

  global.Zip = { zip, textFile, crc32 };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined') module.exports = (typeof window !== 'undefined' ? window : globalThis).Zip;
