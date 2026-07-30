/* ヒルベルト解析信号から音を作る（ブラウザ側）。
 *
 * 解析側（analysis/sonify.py）と同じ手順で計算する：
 *   gyro_x × 2000 → バターワース4次ローパス（filtfilt＝ゼロ位相） → ヒルベルト変換
 *   → 瞬時振幅 a(t) と 瞬時位相 φ(t) → sin(N·φ)·a
 *
 * 一致の程度は tools/compare_with_python.js で毎回実測して記録すること。
 * 完全一致は狙わない（FFT長の扱いが numpy と異なるため端で差が出る）。
 * 聴いた音そのものは wav として保存するので、それが唯一の実体。
 */
(function (global) {
  'use strict';

  // ---- FFT（基数2・in-place）。長さは2のべき乗に切り上げてゼロ詰め ----
  function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {          // ビット反転並べ替え
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  // ---- バターワース4次ローパス（双一次変換）。scipy.signal.butter と同じ係数を出す ----
  function butterLowpass(order, cutoff, fs) {
    const wn = cutoff / (fs / 2);                 // 正規化周波数 0..1
    const warped = Math.tan(Math.PI * wn / 2);    // 周波数プリワープ
    // 2次セクション（バイクアッド）の縦続で作る
    let b = [1], a = [1];
    for (let k = 0; k < order / 2; k++) {
      const theta = Math.PI * (2 * k + 1) / (2 * order);
      const q = 1 / (2 * Math.sin(theta));        // 各セクションのQ
      const w = warped, w2 = w * w;
      const d = 1 + w / q + w2;
      const sb = [w2 / d, 2 * w2 / d, w2 / d];
      const sa = [1, (2 * (w2 - 1)) / d, (1 - w / q + w2) / d];
      b = conv(b, sb); a = conv(a, sa);
    }
    return { b, a };
  }
  function conv(x, y) {
    const r = new Array(x.length + y.length - 1).fill(0);
    for (let i = 0; i < x.length; i++) for (let j = 0; j < y.length; j++) r[i + j] += x[i] * y[j];
    return r;
  }

  function lfilter(b, a, x) {
    const y = new Float64Array(x.length);
    for (let n = 0; n < x.length; n++) {
      let acc = 0;
      for (let i = 0; i < b.length; i++) if (n - i >= 0) acc += b[i] * x[n - i];
      for (let i = 1; i < a.length; i++) if (n - i >= 0) acc -= a[i] * y[n - i];
      y[n] = acc / a[0];
    }
    return y;
  }

  // scipy.signal.filtfilt 相当：奇関数パディング → 順方向 → 反転 → 順方向 → 反転
  function filtfilt(b, a, x) {
    const padlen = 3 * Math.max(a.length, b.length);
    if (x.length <= padlen) return lfilter(b, a, x);
    const n = x.length, ext = new Float64Array(n + 2 * padlen);
    for (let i = 0; i < padlen; i++) ext[i] = 2 * x[0] - x[padlen - i];              // odd 拡張
    for (let i = 0; i < n; i++) ext[padlen + i] = x[i];
    for (let i = 0; i < padlen; i++) ext[padlen + n + i] = 2 * x[n - 1] - x[n - 2 - i];
    let y = lfilter(b, a, ext);
    y = lfilter(b, a, y.slice().reverse()).reverse();
    return y.slice(padlen, padlen + n);
  }

  // ---- ヒルベルト変換：解析信号の虚部を返す ----
  function hilbertImag(x) {
    const n = x.length, N = nextPow2(n);
    const re = new Float64Array(N), im = new Float64Array(N);
    re.set(x);
    fft(re, im, false);
    // 正の周波数を2倍、負の周波数を0に（直流とナイキストはそのまま）
    for (let i = 1; i < N / 2; i++) { re[i] *= 2; im[i] *= 2; }
    for (let i = N / 2 + 1; i < N; i++) { re[i] = 0; im[i] = 0; }
    fft(re, im, true);
    return im.slice(0, n);
  }

  // ---- gyro_x の系列 → 瞬時振幅と瞬時位相 ----
  // gyro: 正規化値の配列（CSVの生値）。fs: サンプリング周波数。cutoff: 0ならローパスなし
  function analytic(gyro, fs, cutoff) {
    let sig = new Float64Array(gyro.length);
    for (let i = 0; i < gyro.length; i++) sig[i] = gyro[i] * 2000;
    if (cutoff > 0) {
      const { b, a } = butterLowpass(4, cutoff, fs);
      sig = filtfilt(b, a, sig);
    }
    const imag = hilbertImag(sig);
    const amp = new Float64Array(sig.length), ph = new Float64Array(sig.length);
    let prev = 0, off = 0;
    for (let i = 0; i < sig.length; i++) {
      amp[i] = Math.hypot(sig[i], imag[i]);
      let p = Math.atan2(imag[i], sig[i]);
      if (i > 0) {                                   // アンラップ
        let d = p - prev;
        if (d > Math.PI) off -= 2 * Math.PI;
        else if (d < -Math.PI) off += 2 * Math.PI;
      }
      prev = p; ph[i] = p + off;
    }
    return { sig, imag, amp, phase: ph };
  }

  // ---- 案B：発振器の位相 = N × 運動の位相 ----
  // 振幅は最大値で割るだけ（加工なし）。sr は出力のサンプリング周波数
  function renderPhaseSound(amp, phase, fs, sr, nMult) {
    const dur = (amp.length - 1) / fs;
    const out = new Float32Array(Math.floor(dur * sr));
    let ampMax = 0;
    for (let i = 0; i < amp.length; i++) if (amp[i] > ampMax) ampMax = amp[i];
    if (ampMax === 0) ampMax = 1;
    for (let k = 0; k < out.length; k++) {
      const u = k / sr * fs;                        // データ側のインデックス（小数）
      const i = Math.min(Math.floor(u), amp.length - 2), f = u - i;
      const ph = phase[i] + (phase[i + 1] - phase[i]) * f;
      const a = (amp[i] + (amp[i + 1] - amp[i]) * f) / ampMax;
      out[k] = Math.sin(nMult * ph) * a;
    }
    return fadeEnds(normalize(out, 0.89), sr);
  }

  // ---- 対照条件：凍らせた音（時間反転） ----
  // 運動の音をそのまま逆再生する。振幅の分布・ケイデンス・音色・音の豊かさは
  // 統計的にほぼ同一のまま、「今の運動との瞬間ごとの対応」だけが壊れる。
  // ＝ yoked control。「音があったから変わった」と「"自分の"音だったから変わった」を分ける。
  // 他人や別日の音を使う案は採らない（それは"手本"になってしまい設計の原則に触る）。
  function renderFrozen(samples) {
    const n = samples.length, out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = samples[n - 1 - i];
    return out;   // 元の音は両端に30msのフェードが入っているので、反転しても端は無音のまま
  }

  // ---- 対照条件：メトロノーム（平均ケイデンスでクリック） ----
  function renderMetronome(periodS, durS, sr) {
    const out = new Float32Array(Math.floor(durS * sr));
    const nClick = Math.floor(0.004 * sr);
    for (let t = 0; t < durS; t += periodS) {
      const k0 = Math.floor(t * sr);
      for (let j = 0; j < nClick && k0 + j < out.length; j++) {
        out[k0 + j] = Math.exp(-6 * j / nClick) * Math.sin(2 * Math.PI * 1000 * j / sr);
      }
    }
    return fadeEnds(normalize(out, 0.89), sr);
  }

  function normalize(x, peak) {
    let m = 0;
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > m) m = Math.abs(x[i]);
    if (m > 0) for (let i = 0; i < x.length; i++) x[i] = x[i] / m * peak;
    return x;
  }
  function fadeEnds(x, sr, ms) {
    const n = Math.floor(sr * (ms || 30) / 1000);
    if (x.length > 2 * n) {
      for (let i = 0; i < n; i++) { x[i] *= i / n; x[x.length - 1 - i] *= i / n; }
    }
    return x;
  }

  // ---- wav（16bit PCM モノラル）にする ----
  function toWavBlob(samples, sr) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); ws(8, 'WAVE');
    ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  global.Sonify = {
    analytic, renderPhaseSound, renderMetronome, renderFrozen, toWavBlob,
    butterLowpass, filtfilt, hilbertImag, nextPow2
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined') module.exports = (typeof window !== 'undefined' ? window : globalThis).Sonify;
