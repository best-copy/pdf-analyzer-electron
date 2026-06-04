/**
 * PDF 흑백변환 Web Worker
 * - JPEG → FlateDecode+DeviceGray
 * - FlateDecode RGB/CMYK → FlateDecode DeviceGray
 * - 컨텐츠 스트림 색상 연산자 그레이스케일 치환
 * OffscreenCanvas + pako 사용 (Electron Chromium 환경)
 */

importScripts('./libs/pako.min.js');

// ── PNG 예측 필터 복원 ─────────────────────────────────────────────────────
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function removePNGPredictor(raw, w, ch) {
  const stride = w * ch;
  const h = Math.floor(raw.length / (stride + 1));
  if (h < 1 || raw.length !== h * (stride + 1)) return null;
  const out = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const si = y * (stride + 1) + 1;
    const di = y * stride;
    const pi = di - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[si + x];
      const a = x >= ch ? out[di + x - ch] : 0;
      const b = y > 0   ? out[pi + x]      : 0;
      const c = y > 0 && x >= ch ? out[pi + x - ch] : 0;
      switch (ft) {
        case 1: out[di + x] = (v + a) & 0xff; break;
        case 2: out[di + x] = (v + b) & 0xff; break;
        case 3: out[di + x] = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: out[di + x] = (v + paethPredictor(a, b, c)) & 0xff; break;
        default: out[di + x] = v; break;
      }
    }
  }
  return out;
}

function applyPNGPredictorGray(raw, w, h) {
  const out = new Uint8Array(h * (w + 1));
  for (let y = 0; y < h; y++) {
    out[y * (w + 1)] = 1;
    for (let x = 0; x < w; x++) {
      const a = x > 0 ? raw[y * w + x - 1] : 0;
      out[y * (w + 1) + 1 + x] = (raw[y * w + x] - a) & 0xff;
    }
  }
  return out;
}

// ── Dot Gain 보정 LUT ────────────────────────────────────────────────────────
// Dot Gain G%: 잉크 닷이 인쇄 시 번져 보이는 현상 보정
// 모델: apparent_coverage = t + 4G·t·(1-t) (파라볼라)
// 역산: 원하는 표시 농도 L에서 장치값 d 도출 → PDF 저장값 = 1-d
// G=25% 특수: (1-t)² = L → t = 1-√L → stored = √L (간단한 sqrt)
// G=20%: 0.8·d²-1.8·d+(1-L)=0 → d = (1.8-√(0.04+3.2L))/1.6
function buildDotGainLUT(gain) {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255; // v: 0=검정, 1=흰색 (PDF DeviceGray 기준)
    let out;
    if (gain === 25) {
      out = Math.sqrt(v);
    } else if (gain === 20) {
      const disc = 0.04 + 3.2 * v;
      const d = disc < 0 ? 0 : (1.8 - Math.sqrt(disc)) / 1.6;
      out = 1 - Math.max(0, Math.min(1, d));
    } else {
      out = v;
    }
    lut[i] = Math.round(Math.max(0, Math.min(255, out * 255)));
  }
  return lut;
}

// ── 컨텐츠 스트림 색상 연산자 치환 ───────────────────────────────────────────
function decodeLatin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
function encodeLatin1(str) {
  const b = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0xff;
  return b;
}

function grayifyStream(bytes, csGrayMap, dotGain) {
  const s = decodeLatin1(bytes);
  const nb = '(-?\\d*\\.?\\d+)';
  const ws = '\\s+';
  // dotGain 보정 함수 (0-1 범위, 0=검정 1=흰색)
  const dgApply = (v) => {
    if (!dotGain) return v;
    const vv = Math.max(0, Math.min(1, v));
    if (dotGain === 25) return Math.sqrt(vv);
    if (dotGain === 20) {
      const disc = 0.04 + 3.2 * vv;
      const d = (1.8 - Math.sqrt(disc < 0 ? 0 : disc)) / 1.6;
      return 1 - Math.max(0, Math.min(1, d));
    }
    return vv;
  };
  // BT.601 휘도: JPEG Y채널 공식과 일치 → 이미지·벡터 동일 기준
  const lum = (r, g, b) => dgApply(0.299*+r + 0.587*+g + 0.114*+b).toFixed(4);
  const lumCmyk = (c, m, y, k) => {
    const R = (1-+c)*(1-+k), G = (1-+m)*(1-+k), B = (1-+y)*(1-+k);
    return dgApply(0.299*R + 0.587*G + 0.114*B).toFixed(4);
  };

  // csGrayMap을 사용하여 Separation tint → 정확한 그레이 변환
  // Type 2 함수: f(t) = C0 + t^N * (C1 - C0)
  const tintToGray = (csInfo, t) => {
    const tv = +t;
    const tN = Math.pow(tv, csInfo.N);
    const ch = csInfo.c0.map((c0v, i) => c0v + tN * (csInfo.c1[i] - c0v));
    const alt = csInfo.altName;
    if (alt === '/DeviceCMYK' && ch.length >= 4) {
      return lumCmyk(ch[0], ch[1], ch[2], ch[3]);
    } else if (alt === '/DeviceRGB' && ch.length >= 3) {
      return lum(ch[0], ch[1], ch[2]);
    } else if (alt === '/DeviceGray' && ch.length >= 1) {
      return dgApply(+ch[0]).toFixed(4);
    }
    // 알 수 없는 색공간 — 단순 반전 폴백
    return dgApply(1 - tv).toFixed(4);
  };

  // 현재 스트로크/채우기 색공간 이름 추적 (cs/CS 연산자 파싱)
  // → scn/SCN에서 색공간 이름별 정확한 변환 적용
  let fillCS = null, strokeCS = null;

  const applyOps = seg => {
    // /name cs, /name CS 색공간 지정 추적 (제거 전에 캡처)
    seg = seg.replace(/\/(\w+)\s+cs(?=[\s\r\n]|$)/gm, (_, name) => { fillCS = '/' + name; return ''; });
    seg = seg.replace(/\/(\w+)\s+CS(?=[\s\r\n]|$)/gm, (_, name) => { strokeCS = '/' + name; return ''; });
    // rg/RG (RGB)
    seg = seg.replace(new RegExp(`${nb}${ws}${nb}${ws}${nb}${ws}rg(?=[\\s\\r\\n]|$)`, 'gm'),
      (_, r, g, b) => `${lum(r,g,b)} g`);
    seg = seg.replace(new RegExp(`${nb}${ws}${nb}${ws}${nb}${ws}RG(?=[\\s\\r\\n]|$)`, 'gm'),
      (_, r, g, b) => `${lum(r,g,b)} G`);
    // k/K (CMYK)
    seg = seg.replace(new RegExp(`${nb}${ws}${nb}${ws}${nb}${ws}${nb}${ws}k(?=[\\s\\r\\n]|$)`, 'gm'),
      (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} g`);
    seg = seg.replace(new RegExp(`${nb}${ws}${nb}${ws}${nb}${ws}${nb}${ws}K(?=[\\s\\r\\n]|$)`, 'gm'),
      (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} G`);
    // sc/SC/scn/SCN (Separation, DeviceN, 명명된 색공간) — 4인수→3인수→1인수 순서
    // 4인수 CMYK 계열
    seg = seg.replace(new RegExp(`${nb}${ws}${nb}${ws}${nb}${ws}${nb}${ws}SCN(?=[\\s\\r\\n]|$)`, 'gm'),
      (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} G`);
    seg = seg.replace(new RegExp(`${nb}${ws}${nb}${ws}${nb}${ws}${nb}${ws}scn(?=[\\s\\r\\n]|$)`, 'gm'),
      (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} g`);
    seg = seg.replace(new RegExp(`${nb}${ws}${nb}${ws}${nb}${ws}${nb}${ws}SC(?=[\\s\\r\\n]|$)`, 'gm'),
      (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} G`);
    seg = seg.replace(new RegExp(`${nb}${ws}${nb}${ws}${nb}${ws}${nb}${ws}sc(?=[\\s\\r\\n]|$)`, 'gm'),
      (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} g`);
    // 3인수 RGB 계열
    seg = seg.replace(new RegExp(`${nb}${ws}${nb}${ws}${nb}${ws}SCN(?=[\\s\\r\\n]|$)`, 'gm'),
      (_, r, g, b) => `${lum(r,g,b)} G`);
    seg = seg.replace(new RegExp(`${nb}${ws}${nb}${ws}${nb}${ws}scn(?=[\\s\\r\\n]|$)`, 'gm'),
      (_, r, g, b) => `${lum(r,g,b)} g`);
    seg = seg.replace(new RegExp(`${nb}${ws}${nb}${ws}${nb}${ws}SC(?=[\\s\\r\\n]|$)`, 'gm'),
      (_, r, g, b) => `${lum(r,g,b)} G`);
    seg = seg.replace(new RegExp(`${nb}${ws}${nb}${ws}${nb}${ws}sc(?=[\\s\\r\\n]|$)`, 'gm'),
      (_, r, g, b) => `${lum(r,g,b)} g`);
    // 1인수 Separation 계열 — csGrayMap으로 정확한 변환, 없으면 반전 폴백
    seg = seg.replace(new RegExp(`${nb}${ws}SCN(?=[\\s\\r\\n]|$)`, 'gm'), (_, t) => {
      const info = strokeCS && csGrayMap && csGrayMap[strokeCS];
      return `${info ? tintToGray(info, t) : (1 - +t).toFixed(4)} G`;
    });
    seg = seg.replace(new RegExp(`${nb}${ws}scn(?=[\\s\\r\\n]|$)`, 'gm'), (_, t) => {
      const info = fillCS && csGrayMap && csGrayMap[fillCS];
      return `${info ? tintToGray(info, t) : (1 - +t).toFixed(4)} g`;
    });
    seg = seg.replace(new RegExp(`${nb}${ws}SC(?=[\\s\\r\\n]|$)`, 'gm'), (_, t) => {
      const info = strokeCS && csGrayMap && csGrayMap[strokeCS];
      return `${info ? tintToGray(info, t) : (1 - +t).toFixed(4)} G`;
    });
    seg = seg.replace(new RegExp(`${nb}${ws}sc(?=[\\s\\r\\n]|$)`, 'gm'), (_, t) => {
      const info = fillCS && csGrayMap && csGrayMap[fillCS];
      return `${info ? tintToGray(info, t) : (1 - +t).toFixed(4)} g`;
    });
    return seg;
  };

  let result = '', i = 0, segStart = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '(') {
      result += applyOps(s.slice(segStart, i));
      let depth = 1, j = i + 1;
      while (j < s.length && depth > 0) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '(') depth++;
        else if (s[j] === ')') depth--;
        j++;
      }
      result += s.slice(i, j);
      i = j; segStart = i;
    } else if (ch === '<' && (i + 1 >= s.length || s[i + 1] !== '<')) {
      const end = s.indexOf('>', i + 1);
      if (end >= 0) {
        result += applyOps(s.slice(segStart, i));
        result += s.slice(i, end + 1);
        i = end + 1; segStart = i;
      } else { i++; }
    } else { i++; }
  }
  result += applyOps(s.slice(segStart));
  return encodeLatin1(result);
}

// ── PNG 빌더 (iCCP 포함) — ICCBased 이미지의 ICC 보정용 ──────────────────────
const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(typeStr, data) {
  const type = [typeStr.charCodeAt(0), typeStr.charCodeAt(1), typeStr.charCodeAt(2), typeStr.charCodeAt(3)];
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set(type, 4);
  if (data.length > 0) chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}
function buildPNGwithICC(raw, w, h, channels, iccBytes) {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  // IHDR
  const ihdrData = new Uint8Array(13);
  const dv = new DataView(ihdrData.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdrData[8] = 8;                          // bit depth
  ihdrData[9] = channels === 3 ? 2 : 0;    // 2=RGB, 0=Gray
  // ihdrData[10-12] = 0 (compression, filter, interlace)
  const ihdr = pngChunk('IHDR', ihdrData);
  // iCCP
  let iccp = null;
  if (iccBytes && iccBytes.length > 0) {
    const name = new Uint8Array([105, 99, 99, 0, 0]); // 'icc\0\0'
    const comp = pako.deflate(iccBytes, { level: 1 });
    const iccpData = new Uint8Array(name.length + comp.length);
    iccpData.set(name, 0); iccpData.set(comp, name.length);
    iccp = pngChunk('iCCP', iccpData);
  }
  // IDAT — filter byte 0 (None) per row
  const stride = w * channels;
  const filtered = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    filtered[y * (stride + 1)] = 0;
    filtered.set(raw.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = pngChunk('IDAT', pako.deflate(filtered, { level: 1 }));
  const iend = pngChunk('IEND', new Uint8Array(0));

  let total = sig.length + ihdr.length + idat.length + iend.length;
  if (iccp) total += iccp.length;
  const out = new Uint8Array(total);
  let pos = 0;
  out.set(sig, pos); pos += sig.length;
  out.set(ihdr, pos); pos += ihdr.length;
  if (iccp) { out.set(iccp, pos); pos += iccp.length; }
  out.set(idat, pos); pos += idat.length;
  out.set(iend, pos);
  return out;
}

// ── 메인 메시지 핸들러 ────────────────────────────────────────────────────────
self.onmessage = async function(e) {
  const { id, type, payload } = e.data;
  try {

    // ── JPEG → FlateDecode+DeviceGray ──────────────────────────────────────
    if (type === 'jpeg2gray') {
      const { jpegBytes, dotGain } = payload;
      let gray = null, iw, ih;

      // 방법 1: ImageDecoder Y-채널 직접 추출
      // JPEG 내부 Y값 = BT.601 휘도(압축 전 원본 기준) → 벡터 색상과 일관된 변환
      try {
        if (typeof ImageDecoder !== 'undefined') {
          const jpegArr = new Uint8Array(jpegBytes);
          const decoder = new ImageDecoder({
            data: new ReadableStream({
              start(ctrl) { ctrl.enqueue(jpegArr); ctrl.close(); }
            }),
            type: 'image/jpeg',
            colorSpaceConversion: 'none',  // YCbCr 그대로 유지 (RGB 변환 없음)
          });
          const { image: frame } = await decoder.decode();
          iw = frame.codedWidth;
          ih = frame.codedHeight;
          // I420: Y 플레인 = 앞 iw*ih 바이트 (full-resolution 휘도)
          const bufSize = Math.ceil(iw * ih * 3 / 2);
          const buf = new ArrayBuffer(bufSize);
          await frame.copyTo(buf, { format: 'I420' });
          frame.close();
          decoder.close();
          gray = new Uint8Array(buf.slice(0, iw * ih)); // Y 플레인만
        }
      } catch(e) { gray = null; }

      // 방법 2: OffscreenCanvas + BT.601 폴백
      if (!gray) {
        const blob = new Blob([new Uint8Array(jpegBytes)], { type: 'image/jpeg' });
        const bitmap = await createImageBitmap(blob);
        iw = bitmap.width; ih = bitmap.height;
        const canvas = new OffscreenCanvas(iw, ih);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const d = ctx.getImageData(0, 0, iw, ih).data;
        gray = new Uint8Array(iw * ih);
        for (let pi = 0; pi < gray.length; pi++)
          gray[pi] = Math.round(0.299*d[pi*4] + 0.587*d[pi*4+1] + 0.114*d[pi*4+2]);
      }

      if (dotGain) { const lut = buildDotGainLUT(dotGain); for (let i = 0; i < gray.length; i++) gray[i] = lut[gray[i]]; }
      const predicted  = applyPNGPredictorGray(gray, iw, ih);
      const deflated   = pako.deflate(predicted, { level: 6 });
      // pako는 단일 청크일 때 내부 버퍼의 subarray를 반환할 수 있음
      // → .buffer.byteLength > .length 인 경우 PDF Length가 잘못 기록되어 파일이 열리지 않음
      // → slice()로 정확한 크기의 새 버퍼 생성
      const deflatedBuf = deflated.buffer.slice(deflated.byteOffset, deflated.byteOffset + deflated.length);
      self.postMessage({ id, result: { deflated: deflatedBuf, w: iw, h: ih } }, [deflatedBuf]);

    // ── FlateDecode RGB/CMYK → FlateDecode DeviceGray ──────────────────────
    } else if (type === 'flate2gray') {
      const { compressed, w, h, channels, predictor, dotGain } = payload;
      let raw = pako.inflate(new Uint8Array(compressed));

      if (predictor >= 10) {
        const decoded = removePNGPredictor(raw, w, channels);
        if (!decoded || decoded.length !== w * h * channels) {
          self.postMessage({ id, error: 'predictor_fail' }); return;
        }
        raw = decoded;
      } else if (predictor === 2) {
        if (raw.length !== w * h * channels) {
          self.postMessage({ id, error: 'length_fail' }); return;
        }
        for (let y = 0; y < h; y++)
          for (let x = channels; x < w * channels; x++)
            raw[y * w * channels + x] = (raw[y * w * channels + x] + raw[y * w * channels + x - channels]) & 0xff;
      } else {
        if (raw.length !== w * h * channels) {
          self.postMessage({ id, error: 'length_fail' }); return;
        }
      }

      const gray = new Uint8Array(w * h);
      if (channels === 4) {
        for (let i = 0, j = 0; i < raw.length; i += 4, j++) {
          const c = raw[i]/255, m = raw[i+1]/255, yc = raw[i+2]/255, k = raw[i+3]/255;
          const R = (1-c)*(1-k), G = (1-m)*(1-k), B = (1-yc)*(1-k);
          gray[j] = Math.round(255 * (0.299*R + 0.587*G + 0.114*B));
        }
      } else {
        for (let i = 0, j = 0; i < raw.length; i += 3, j++)
          gray[j] = Math.round(0.299*raw[i] + 0.587*raw[i+1] + 0.114*raw[i+2]);
      }

      if (dotGain) { const lut = buildDotGainLUT(dotGain); for (let i = 0; i < gray.length; i++) gray[i] = lut[gray[i]]; }
      const predicted = applyPNGPredictorGray(gray, w, h);
      const deflated  = pako.deflate(predicted, { level: 6 });
      const deflatedBuf = deflated.buffer.slice(deflated.byteOffset, deflated.byteOffset + deflated.length);
      self.postMessage({ id, result: { deflated: deflatedBuf, w, h } }, [deflatedBuf]);

    // ── ICCBased FlateDecode → DeviceGray (PNG+iCCP → OffscreenCanvas ICC 보정) ──
    } else if (type === 'icc-flate2gray') {
      const { compressed, w, h, channels, predictor, iccBytes, dotGain } = payload;
      let raw = pako.inflate(new Uint8Array(compressed));

      if (predictor >= 10) {
        const decoded = removePNGPredictor(raw, w, channels);
        if (!decoded || decoded.length !== w * h * channels) {
          self.postMessage({ id, error: 'predictor_fail' }); return;
        }
        raw = decoded;
      } else if (predictor === 2) {
        if (raw.length !== w * h * channels) {
          self.postMessage({ id, error: 'length_fail' }); return;
        }
        for (let y = 0; y < h; y++)
          for (let x = channels; x < w * channels; x++)
            raw[y * w * channels + x] = (raw[y * w * channels + x] + raw[y * w * channels + x - channels]) & 0xff;
      } else {
        if (raw.length !== w * h * channels) {
          self.postMessage({ id, error: 'length_fail' }); return;
        }
      }

      // PNG + iCCP 빌드 → createImageBitmap으로 ICC 보정 픽셀 획득
      const icc = iccBytes ? new Uint8Array(iccBytes) : null;
      const pngData = buildPNGwithICC(raw, w, h, channels, icc);
      const blob = new Blob([pngData], { type: 'image/png' });
      const bitmap = await createImageBitmap(blob);
      const bw = bitmap.width, bh = bitmap.height;
      const canvas = new OffscreenCanvas(bw, bh);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const d = ctx.getImageData(0, 0, bw, bh).data;

      const gray = new Uint8Array(bw * bh);
      for (let pi = 0; pi < gray.length; pi++)
        gray[pi] = Math.round(0.299*d[pi*4] + 0.587*d[pi*4+1] + 0.114*d[pi*4+2]);

      if (dotGain) { const lut = buildDotGainLUT(dotGain); for (let i = 0; i < gray.length; i++) gray[i] = lut[gray[i]]; }
      const predicted = applyPNGPredictorGray(gray, bw, bh);
      const deflated  = pako.deflate(predicted, { level: 6 });
      const deflatedBuf = deflated.buffer.slice(deflated.byteOffset, deflated.byteOffset + deflated.length);
      self.postMessage({ id, result: { deflated: deflatedBuf, w: bw, h: bh } }, [deflatedBuf]);

    // ── 컨텐츠 스트림 색상 연산자 치환 ─────────────────────────────────────
    } else if (type === 'stream-grayify') {
      const { bytes, wasCompressed, csGrayMap, dotGain } = payload;
      let raw = new Uint8Array(bytes);
      if (wasCompressed) {
        try { raw = pako.inflate(raw); }
        catch(e) { self.postMessage({ id, error: 'inflate_fail' }); return; }
      }
      const processed = grayifyStream(raw, csGrayMap || {}, dotGain || 0);
      let out = processed;
      if (wasCompressed) out = pako.deflate(processed, { level: 6 });
      self.postMessage({ id, result: { bytes: out.buffer, length: out.length } }, [out.buffer]);

    } else {
      self.postMessage({ id, error: 'unknown_type' });
    }

  } catch(err) {
    self.postMessage({ id, error: String(err) });
  }
};
