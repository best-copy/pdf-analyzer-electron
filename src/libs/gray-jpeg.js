// 1성분(DeviceGray) 기준형 JPEG 인코더 — worker-gray.js jpeg2gray가 흑백 사진을 다시 JPEG로 담을 때 쓴다.
// 왜 직접 만드나: Chromium 캔버스는 1성분 JPEG를 못 만든다 → 회색을 RGB JPEG로 담으면 프린터·gs inkcov가
// CMY를 잡아 컬러로 셀 수 있다. 1성분 JPEG는 같은 품질(q82, PSNR 동일)에서 RGB JPEG의 94%(실측 158장).
// IJG 휘도 양자화표·libjpeg 품질 스케일, 허프만 표는 이미지에 맞춰 만든다(JPEG 부록 K.2 = libjpeg optimize_coding).
// ⚠ DHT 길이 필드가 1바이트만 틀려도 jpeg-js는 받아 주지만 Chromium은 거부한다 — 고치면 gray-jpeg.test.js로 확인.
(function (root) {
  const ZZ = [0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63];
  const ZR = new Uint8Array(64); ZZ.forEach((r, z) => { ZR[r] = z; });   // 래스터 → 지그재그 위치
  const YQ = [16,11,10,16,24,40,51,61,12,12,14,19,26,58,60,55,14,13,16,24,40,57,69,56,14,17,22,29,51,87,80,62,18,22,37,56,68,109,103,77,24,35,55,64,81,104,113,92,49,64,78,87,103,121,120,101,72,92,95,98,112,100,103,99];
  const AAN = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.541196100, 0.275899379];

  // BITS/HUFFVAL → 기호별 [코드, 길이]
  function codesOf(t) {
    const code = new Uint16Array(256), len = new Uint8Array(256);
    let c = 0, k = 0;
    for (let l = 1; l <= 16; l++) { for (let i = 0; i < t.bits[l]; i++) { const s = t.vals[k++]; code[s] = c; len[s] = l; c++; } c <<= 1; }
    return { code, len };
  }
  // JPEG 부록 K.2 — 빈도 → 최대 16비트 허프만 표
  function optimalTable(freq) {
    const f = Array.from(freq); f[256] = 1;                 // 모든 비트가 1인 코드를 막는 예약 기호
    const codesize = new Array(257).fill(0), others = new Array(257).fill(-1);
    for (;;) {
      let c1 = -1, v = Infinity;
      for (let i = 0; i <= 256; i++) if (f[i] && f[i] <= v) { v = f[i]; c1 = i; }
      let c2 = -1; v = Infinity;
      for (let i = 0; i <= 256; i++) if (f[i] && f[i] <= v && i !== c1) { v = f[i]; c2 = i; }
      if (c2 < 0) break;
      f[c1] += f[c2]; f[c2] = 0;
      codesize[c1]++; while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++; }
      others[c1] = c2;
      codesize[c2]++; while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++; }
    }
    const bits = new Array(33).fill(0);
    for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;
    for (let i = 32; i > 16; i--) {
      while (bits[i] > 0) {
        let j = i - 2; while (bits[j] === 0) j--;
        bits[i] -= 2; bits[i - 1]++; bits[j + 1] += 2; bits[j]--;
      }
    }
    let i = 16; while (bits[i] === 0) i--; bits[i]--;        // 예약 기호 제거
    const vals = [];
    for (let l = 1; l <= 32; l++) for (let s = 0; s < 256; s++) if (codesize[s] === l) vals.push(s);
    return { bits: [0, ...bits.slice(1, 17)], vals };
  }
  const nbits = v => { let a = v < 0 ? -v : v, n = 0; while (a) { n++; a >>= 1; } return n; };

  // gray: Uint8Array(w*h) · quality 1~100 → Uint8Array(JPEG)
  function encodeGrayJpeg(gray, w, h, quality) {
    if (!(w > 0 && h > 0 && w <= 65535 && h <= 65535) || gray.length < w * h) throw new Error('gray-jpeg: 크기 오류');
    quality = Math.max(1, Math.min(100, Math.round(quality || 82)));
    const qs = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
    const qt = new Uint8Array(64), fdtbl = new Float64Array(64);
    for (let i = 0; i < 64; i++) qt[ZR[i]] = Math.min(255, Math.max(1, Math.floor((YQ[i] * qs + 50) / 100)));
    for (let r = 0, k = 0; r < 8; r++) for (let c = 0; c < 8; c++, k++) fdtbl[k] = 1 / (qt[ZR[k]] * AAN[r] * AAN[c] * 8);

    // 1) 모든 블록을 DCT·양자화해 둔다(지그재그 순서) — 허프만 표를 먼저 세고 나서 쓰기 위해
    const bw = Math.ceil(w / 8), bh = Math.ceil(h / 8), nb = bw * bh;
    const blocks = new Int16Array(nb * 64);
    const d = new Float64Array(64);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const y = by * 8, x = bx * 8;
      for (let r = 0; r < 8; r++) {
        const row = Math.min(h - 1, y + r) * w;           // 가장자리는 마지막 픽셀을 늘려 채운다
        for (let c = 0; c < 8; c++) d[r * 8 + c] = gray[row + Math.min(w - 1, x + c)] - 128;
      }
      for (let o = 0; o < 64; o += 8) {                     // AAN 순방향 DCT — 행
        const t0 = d[o] + d[o+7], t7 = d[o] - d[o+7], t1 = d[o+1] + d[o+6], t6 = d[o+1] - d[o+6];
        const t2 = d[o+2] + d[o+5], t5 = d[o+2] - d[o+5], t3 = d[o+3] + d[o+4], t4 = d[o+3] - d[o+4];
        let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
        d[o] = t10 + t11; d[o+4] = t10 - t11;
        const z1 = (t12 + t13) * 0.707106781; d[o+2] = t13 + z1; d[o+6] = t13 - z1;
        t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
        const z5 = (t10 - t12) * 0.382683433, z2 = 0.541196100 * t10 + z5, z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781;
        const z11 = t7 + z3, z13 = t7 - z3;
        d[o+5] = z13 + z2; d[o+3] = z13 - z2; d[o+1] = z11 + z4; d[o+7] = z11 - z4;
      }
      for (let c = 0; c < 8; c++) {                         // — 열
        const t0 = d[c] + d[c+56], t7 = d[c] - d[c+56], t1 = d[c+8] + d[c+48], t6 = d[c+8] - d[c+48];
        const t2 = d[c+16] + d[c+40], t5 = d[c+16] - d[c+40], t3 = d[c+24] + d[c+32], t4 = d[c+24] - d[c+32];
        let t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
        d[c] = t10 + t11; d[c+32] = t10 - t11;
        const z1 = (t12 + t13) * 0.707106781; d[c+16] = t13 + z1; d[c+48] = t13 - z1;
        t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
        const z5 = (t10 - t12) * 0.382683433, z2 = 0.541196100 * t10 + z5, z4 = 1.306562965 * t12 + z5, z3 = t11 * 0.707106781;
        const z11 = t7 + z3, z13 = t7 - z3;
        d[c+40] = z13 + z2; d[c+24] = z13 - z2; d[c+8] = z11 + z4; d[c+56] = z11 - z4;
      }
      const base = (by * bw + bx) * 64;
      for (let i = 0; i < 64; i++) blocks[base + ZR[i]] = Math.round(d[i] * fdtbl[i]);
    }

    // 2) 기호 열거 — emit(dc여부, 기호, 추가비트 값, 추가비트 수)
    const walk = emit => {
      let dcPrev = 0;
      for (let b = 0; b < nb; b++) {
        const o = b * 64;
        const diff = blocks[o] - dcPrev; dcPrev = blocks[o];
        const n = nbits(diff); emit(true, n, diff < 0 ? diff + (1 << n) - 1 : diff, n);
        let end = 63; while (end > 0 && blocks[o + end] === 0) end--;
        let i = 1;
        while (i <= end) {
          let run = 0; while (blocks[o + i] === 0) { run++; i++; }   // i<=end 안에는 0이 아닌 값이 반드시 있다
          while (run >= 16) { emit(false, 0xF0, 0, 0); run -= 16; }
          const v = blocks[o + i], m = nbits(v);
          emit(false, (run << 4) + m, v < 0 ? v + (1 << m) - 1 : v, m); i++;
        }
        if (end !== 63) emit(false, 0x00, 0, 0);
      }
    };
    const fdc = new Float64Array(256), fac = new Float64Array(256);
    walk((dc, s) => { (dc ? fdc : fac)[s]++; });
    const DC = optimalTable(fdc), AC = optimalTable(fac);
    const DCH = codesOf(DC), ACH = codesOf(AC);

    // 3) 쓰기 — 늘어나는 바이트 버퍼
    let out = new Uint8Array(Math.max(4096, (w * h) >> 2)), pos = 0;
    const grow = need => { if (pos + need > out.length) { const n = new Uint8Array(Math.max(out.length * 2, pos + need)); n.set(out.subarray(0, pos)); out = n; } };
    const wb = b => { grow(1); out[pos++] = b & 255; };
    const ww = v => { wb(v >> 8); wb(v); };
    let acc = 0, accBits = 0;                               // 비트 누산기(최대 32비트 미만 유지)
    const bits = (val, len) => {
      acc = (acc << len) | (val & ((1 << len) - 1)); accBits += len;
      while (accBits >= 8) {
        accBits -= 8; const byte = (acc >>> accBits) & 255;
        grow(2); out[pos++] = byte; if (byte === 255) out[pos++] = 0;   // 바이트 스터핑
      }
      acc &= (1 << accBits) - 1;
    };
    ww(0xFFD8);
    ww(0xFFE0); ww(16); [0x4A,0x46,0x49,0x46,0,1,1,0,0,1,0,1,0,0].forEach(wb);
    ww(0xFFDB); ww(67); wb(0); for (let i = 0; i < 64; i++) wb(qt[i]);
    ww(0xFFC0); ww(11); wb(8); ww(h); ww(w); wb(1); wb(1); wb(0x11); wb(0);
    ww(0xFFC4); ww(2 + 17 + DC.vals.length + 17 + AC.vals.length);   // 길이(2) + [종류(1)+개수(16)+값] × 2
    wb(0x00); for (let i = 1; i <= 16; i++) wb(DC.bits[i]); DC.vals.forEach(wb);
    wb(0x10); for (let i = 1; i <= 16; i++) wb(AC.bits[i]); AC.vals.forEach(wb);
    ww(0xFFDA); ww(8); wb(1); wb(1); wb(0); wb(0); wb(63); wb(0);
    walk((dc, s, v, n) => { const H = dc ? DCH : ACH; bits(H.code[s], H.len[s]); if (n) bits(v, n); });
    if (accBits) bits((1 << (8 - accBits)) - 1, 8 - accBits);   // 남은 비트는 1로 채운다
    ww(0xFFD9);
    return out.slice(0, pos);
  }

  root.encodeGrayJpeg = encodeGrayJpeg;
  if (typeof module !== 'undefined' && module.exports) module.exports = { encodeGrayJpeg };
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
