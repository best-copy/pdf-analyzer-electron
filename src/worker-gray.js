/**
 * PDF 흑백변환 Web Worker
 * - JPEG → FlateDecode+DeviceGray
 * - FlateDecode RGB/CMYK → FlateDecode DeviceGray
 * - 컨텐츠 스트림 색상 연산자 그레이스케일 치환
 * OffscreenCanvas + pako 사용 (Electron Chromium 환경)
 */

importScripts('./libs/pako.min.js');

// ── JPEG SOF 마커 파싱: 이미지 컴포넌트 수 반환 ────────────────────────────────
// 3 = YCbCr (일반 RGB JPEG), 4 = CMYK / YCCK (PowerPoint·InDesign 등), 1 = Grayscale
function getJpegComponentCount(data) {
  if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
  if (data.length < 4 || data[0] !== 0xFF || data[1] !== 0xD8) return 3;
  let i = 2;
  while (i + 3 < data.length) {
    if (data[i] !== 0xFF) { i++; continue; }
    const marker = data[i + 1];
    if (marker === 0xDA || marker === 0xD9) break; // SOS / EOI
    const segLen = (data[i+2] << 8) | data[i+3];
    // SOF0-SOF15 (DHT=C4, JPG=C8, DAC=CC 제외)
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return (i + 9 < data.length) ? data[i + 9] : 3;
    }
    i += 2 + segLen;
  }
  return 3;
}

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

// ── 인라인 이미지(BI/EI) 바이트 레벨 전처리 ────────────────────────────────────
// grayifyStream 이전에 실행 — RGB/CMYK 인라인 이미지를 DeviceGray로 변환
// 바이트 배열 직접 처리로 string regex 오염 문제 완전 회피
function preprocessInlineImages(raw, dotGain) {
  const chunks = [];
  let pos = 0;

  while (pos < raw.length) {
    // \nBI\n (0x0A 0x42 0x49 0x0A) 탐색
    let biPos = -1;
    for (let j = pos; j <= raw.length - 4; j++) {
      if (raw[j] === 0x0A && raw[j+1] === 0x42 && raw[j+2] === 0x49 && raw[j+3] === 0x0A) {
        biPos = j; break;
      }
    }
    if (biPos < 0) { chunks.push(raw.slice(pos)); break; }

    // BI 이전 바이트 그대로 추가 (\n 포함)
    chunks.push(raw.slice(pos, biPos + 1));

    // \nID\n (0x0A 0x49 0x44 0x0A) 탐색
    let idPos = -1;
    for (let j = biPos + 4; j <= raw.length - 4; j++) {
      if (raw[j] === 0x0A && raw[j+1] === 0x49 && raw[j+2] === 0x44 && raw[j+3] === 0x0A) {
        idPos = j; break;
      }
    }
    if (idPos < 0) { chunks.push(raw.slice(biPos + 1)); break; }

    // 딕셔너리 파싱 (biPos+4 ~ idPos)
    const dictStr = decodeLatin1(raw.slice(biPos + 4, idPos));
    const getNum = (s, ...keys) => { for (const k of keys) { const m = s.match(new RegExp('\\/' + k + '\\s+(\\d+)')); if (m) return +m[1]; } return 0; };
    const getWord = (s, ...keys) => { for (const k of keys) { const m = s.match(new RegExp('\\/' + k + '\\s+\\/?([A-Za-z]+)')); if (m) return m[1]; } return ''; };

    const w = getNum(dictStr, 'W', 'Width');
    const h = getNum(dictStr, 'H', 'Height');
    const bpc = getNum(dictStr, 'BPC', 'BitsPerComponent') || 8;
    const csWord = getWord(dictStr, 'CS', 'ColorSpace');
    const fWord  = getWord(dictStr, 'F', 'Filter');

    const isRGB  = ['RGB','DeviceRGB','CalRGB'].includes(csWord);
    const isCMYK = ['CMYK','DeviceCMYK'].includes(csWord);
    const hasFilter = fWord !== '' && fWord !== 'None';
    const channels  = isCMYK ? 4 : isRGB ? 3 : 1;
    const dataStart = idPos + 4;

    if (!hasFilter && (isRGB || isCMYK) && bpc === 8 && w > 0 && h > 0) {
      // 비압축 RGB/CMYK → Gray 변환
      const dataLen = w * h * channels;
      const pix = raw.slice(dataStart, dataStart + dataLen);
      const gray = new Uint8Array(w * h);
      if (channels === 3) {
        for (let pi = 0; pi < w * h; pi++)
          gray[pi] = Math.round(0.299*pix[pi*3] + 0.587*pix[pi*3+1] + 0.114*pix[pi*3+2]);
      } else {
        for (let pi = 0; pi < w * h; pi++) {
          const c=pix[pi*4]/255, m2=pix[pi*4+1]/255, y=pix[pi*4+2]/255, k=pix[pi*4+3]/255;
          gray[pi] = Math.round(255*(0.299*(1-c)*(1-k) + 0.587*(1-m2)*(1-k) + 0.114*(1-y)*(1-k)));
        }
      }
      if (dotGain) { const lut = buildDotGainLUT(dotGain); for (let pi = 0; pi < gray.length; pi++) gray[pi] = lut[gray[pi]]; }

      const newDict = encodeLatin1(dictStr.replace(/\/(CS|ColorSpace)\s+\/(RGB|DeviceRGB|CalRGB|CMYK|DeviceCMYK)/g, '/CS /G'));
      chunks.push(encodeLatin1('BI\n'));
      chunks.push(newDict);
      chunks.push(encodeLatin1('\nID\n'));
      chunks.push(gray);

      let nextPos = dataStart + dataLen;
      if (nextPos + 2 < raw.length && raw[nextPos] === 0x0A && raw[nextPos+1] === 0x45 && raw[nextPos+2] === 0x49) {
        chunks.push(encodeLatin1('\nEI')); pos = nextPos + 3;
      } else { chunks.push(encodeLatin1('\nEI')); pos = nextPos; }

    } else if (!hasFilter && w > 0 && h > 0 && bpc === 8) {
      // 이미 그레이 또는 알 수 없는 CS — 그대로 통과 (바이너리 데이터 경계는 확정)
      const dataLen = w * h * channels;
      const nextPos = dataStart + dataLen;
      chunks.push(raw.slice(biPos + 1, nextPos));
      if (nextPos + 2 < raw.length && raw[nextPos] === 0x0A && raw[nextPos+1] === 0x45 && raw[nextPos+2] === 0x49) {
        chunks.push(encodeLatin1('\nEI')); pos = nextPos + 3;
      } else { chunks.push(encodeLatin1('\nEI')); pos = nextPos; }

    } else {
      // 필터 있음 또는 크기 불명 — heuristic EI 탐색 후 그대로 통과
      let eiPos = dataStart;
      while (eiPos < raw.length - 2) {
        if (raw[eiPos] === 0x0A && raw[eiPos+1] === 0x45 && raw[eiPos+2] === 0x49) {
          const after = (eiPos + 3 < raw.length) ? raw[eiPos+3] : 0;
          if (after <= 0x20 || after === 0x51 || after === 0x71) break;
        }
        eiPos++;
      }
      chunks.push(raw.slice(biPos + 1, eiPos));
      chunks.push(encodeLatin1('\nEI'));
      pos = eiPos + 3;
    }
  }

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// ── 관대한 inflate: /Length 손상으로 잘린 스트림 부분 복구 ────────────────────
function inflateLenientW(data, expectedLen, fillValue) {
  try {
    const r = pako.inflate(data);
    if (r && r.length) return r;
  } catch(e) {}
  try {
    const chunks = [];
    const inf = new pako.Inflate();
    inf.onData = (c) => chunks.push(c);
    inf.onEnd = () => {};
    inf.push(data, true);
    const total = chunks.reduce((s, c) => s + c.length, 0);
    if (!total) return null;
    const outLen = expectedLen != null ? Math.max(total, expectedLen) : total;
    const out = new Uint8Array(outLen);
    if (fillValue) out.fill(fillValue);
    let off = 0;
    for (const ch of chunks) { out.set(ch, off); off += ch.length; }
    if (fillValue && off < outLen) out.fill(fillValue, off);
    return out;
  } catch(e) { return null; }
}

// ── 컨텐츠 스트림 색상 연산자 치환 ───────────────────────────────────────────
// 주의: TextDecoder('latin1')은 windows-1252라서 0x80~0x9F가 €(U+20AC) 등으로 디코딩됨
// → charCodeAt & 0xff 재인코딩 시 바이너리 손상. 청크 fromCharCode로 정확한 1:1 왕복 보장
function decodeLatin1(bytes) {
  const CHUNK = 0x8000;
  if (bytes.length <= CHUNK) return String.fromCharCode.apply(null, bytes);
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK)
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  return parts.join('');
}
function encodeLatin1(str) {
  const b = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0xff;
  return b;
}

// applyOps용 정규식 pre-compile (매 호출 new RegExp 생성 방지 — 속도 최적화)
const _NB = '(-?\\d*\\.?\\d+)', _WS = '\\s+', _TL = '(?=[\\s\\r\\n]|$)';
const _RE_rg   = new RegExp(`${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}rg${_TL}`, 'gm');
const _RE_RG   = new RegExp(`${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}RG${_TL}`, 'gm');
const _RE_k    = new RegExp(`${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}k${_TL}`, 'gm');
const _RE_K    = new RegExp(`${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}K${_TL}`, 'gm');
const _RE_SCN4 = new RegExp(`${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}SCN${_TL}`, 'gm');
const _RE_scn4 = new RegExp(`${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}scn${_TL}`, 'gm');
const _RE_SC4  = new RegExp(`${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}SC${_TL}`, 'gm');
const _RE_sc4  = new RegExp(`${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}sc${_TL}`, 'gm');
const _RE_SCN3 = new RegExp(`${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}SCN${_TL}`, 'gm');
const _RE_scn3 = new RegExp(`${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}scn${_TL}`, 'gm');
const _RE_SC3  = new RegExp(`${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}SC${_TL}`, 'gm');
const _RE_sc3  = new RegExp(`${_NB}${_WS}${_NB}${_WS}${_NB}${_WS}sc${_TL}`, 'gm');
const _RE_SCN1 = new RegExp(`${_NB}${_WS}SCN${_TL}`, 'gm');
const _RE_scn1 = new RegExp(`${_NB}${_WS}scn${_TL}`, 'gm');
const _RE_SC1  = new RegExp(`${_NB}${_WS}SC${_TL}`, 'gm');
const _RE_sc1  = new RegExp(`${_NB}${_WS}sc${_TL}`, 'gm');

function grayifyStream(bytes, csGrayMap, dotGain) {
  const s = decodeLatin1(bytes);
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
    // /name cs, /name CS 색공간 지정
    // Pattern 색공간은 제거하지 않음 (제거 시 /P0 SCN 등 패턴 호출이 오류 유발)
    seg = seg.replace(/\/(\w+)\s+cs(?=[\s\r\n]|$)/gm, (_, name) => {
      fillCS = '/' + name;
      // csGrayMap 키는 '/' 포함 형태 (예: '/CS2') → '/' + name 으로 조회
      const info = csGrayMap && csGrayMap['/' + name];
      if (info && info.type === 'Pattern') return `/${name} cs`; // Pattern CS는 유지
      return '';
    });
    seg = seg.replace(/\/(\w+)\s+CS(?=[\s\r\n]|$)/gm, (_, name) => {
      strokeCS = '/' + name;
      const info = csGrayMap && csGrayMap['/' + name];
      if (info && info.type === 'Pattern') return `/${name} CS`; // Pattern CS는 유지
      return '';
    });
    // rg/RG (RGB)
    seg = seg.replace(_RE_rg, (_, r, g, b) => `${lum(r,g,b)} g`);
    seg = seg.replace(_RE_RG, (_, r, g, b) => `${lum(r,g,b)} G`);
    // k/K (CMYK)
    seg = seg.replace(_RE_k, (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} g`);
    seg = seg.replace(_RE_K, (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} G`);
    // sc/SC/scn/SCN (Separation, DeviceN, 명명된 색공간) — 4인수→3인수→1인수 순서
    // 4인수 CMYK 계열
    seg = seg.replace(_RE_SCN4, (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} G`);
    seg = seg.replace(_RE_scn4, (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} g`);
    seg = seg.replace(_RE_SC4,  (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} G`);
    seg = seg.replace(_RE_sc4,  (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} g`);
    // 3인수 RGB 계열
    seg = seg.replace(_RE_SCN3, (_, r, g, b) => `${lum(r,g,b)} G`);
    seg = seg.replace(_RE_scn3, (_, r, g, b) => `${lum(r,g,b)} g`);
    seg = seg.replace(_RE_SC3,  (_, r, g, b) => `${lum(r,g,b)} G`);
    seg = seg.replace(_RE_sc3,  (_, r, g, b) => `${lum(r,g,b)} g`);
    // 1인수 Separation 계열 — csGrayMap으로 정확한 변환, 없으면 반전 폴백
    seg = seg.replace(_RE_SCN1, (_, t) => {
      const info = strokeCS && csGrayMap && csGrayMap[strokeCS];
      return `${info ? tintToGray(info, t) : (1 - +t).toFixed(4)} G`;
    });
    seg = seg.replace(_RE_scn1, (_, t) => {
      const info = fillCS && csGrayMap && csGrayMap[fillCS];
      return `${info ? tintToGray(info, t) : (1 - +t).toFixed(4)} g`;
    });
    seg = seg.replace(_RE_SC1, (_, t) => {
      const info = strokeCS && csGrayMap && csGrayMap[strokeCS];
      return `${info ? tintToGray(info, t) : (1 - +t).toFixed(4)} G`;
    });
    seg = seg.replace(_RE_sc1, (_, t) => {
      const info = fillCS && csGrayMap && csGrayMap[fillCS];
      return `${info ? tintToGray(info, t) : (1 - +t).toFixed(4)} g`;
    });
    return seg;
  };

  // BI 딕셔너리에서 숫자/이름 파싱 헬퍼
  const biGetNum = (d, ...keys) => { for (const k of keys) { const m = d.match(new RegExp('\\/' + k + '\\s+(\\d+)')); if (m) return +m[1]; } return 0; };
  const biGetCS  = (d) => { const m = d.match(/\/(CS|ColorSpace)\s+\/(\w+)/); return m ? '/' + m[2] : ''; };
  const biGetF   = (d) => { const m = d.match(/\/(F(?:ilter)?)\s+\/(\w+)/); return m ? '/' + m[2] : ''; };

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
    } else if (ch === 'B' && s[i+1] === 'I' && (s[i+2] === '\n' || s[i+2] === '\r') &&
               (i === 0 || s[i-1] === '\n' || s[i-1] === '\r')) {
      // ── 인라인 이미지 (BI...ID...EI) ──────────────────────────────────────
      // 바이너리 픽셀 데이터가 regex에 오염되지 않도록 보호 + RGB/CMYK → Gray 변환
      result += applyOps(s.slice(segStart, i));

      const idIdx = s.indexOf('\nID\n', i + 3);
      if (idIdx < 0) { i++; segStart = i; continue; }  // BI 파싱 불가 → 스킵

      const dictStr = s.slice(i + 3, idIdx);  // 'BI\n' 이후 ~ '\nID\n' 이전
      const w  = biGetNum(dictStr, 'W', 'Width');
      const h  = biGetNum(dictStr, 'H', 'Height');
      const bpc = biGetNum(dictStr, 'BPC', 'BitsPerComponent') || 8;
      const csName = biGetCS(dictStr);
      const filterName = biGetF(dictStr);

      const isRGB  = ['/RGB','/DeviceRGB','/CalRGB'].includes(csName);
      const isCMYK = ['/CMYK','/DeviceCMYK'].includes(csName);
      const hasFilter = filterName !== '' && filterName !== '/None';
      const channels  = isCMYK ? 4 : isRGB ? 3 : 1;
      const dataStart = idIdx + 4;  // '\nID\n' 이후

      if (!hasFilter && (isRGB || isCMYK) && bpc === 8 && w > 0 && h > 0) {
        // 비압축 RGB/CMYK 인라인 이미지 → 그레이스케일 변환
        const dataLen = w * h * channels;
        const grayChars = new Array(w * h);
        if (channels === 3) {
          for (let pi = 0; pi < w * h; pi++) {
            const si = dataStart + pi * 3;
            const r = s.charCodeAt(si) & 0xff, g2 = s.charCodeAt(si+1) & 0xff, b2 = s.charCodeAt(si+2) & 0xff;
            grayChars[pi] = String.fromCharCode(Math.round(dgApply(0.299*r/255 + 0.587*g2/255 + 0.114*b2/255) * 255));
          }
        } else {
          for (let pi = 0; pi < w * h; pi++) {
            const si = dataStart + pi * 4;
            const c=s.charCodeAt(si)&0xff, m2=s.charCodeAt(si+1)&0xff, y2=s.charCodeAt(si+2)&0xff, k2=s.charCodeAt(si+3)&0xff;
            const R=(255-c)*(255-k2)/65025, G=(255-m2)*(255-k2)/65025, B2=(255-y2)*(255-k2)/65025;
            grayChars[pi] = String.fromCharCode(Math.round(dgApply(0.299*R + 0.587*G + 0.114*B2) * 255));
          }
        }
        const newDict = dictStr.replace(/\/(CS|ColorSpace)\s+\/(RGB|DeviceRGB|CalRGB|CMYK|DeviceCMYK)/g, '/CS /G');
        result += 'BI\n' + newDict + '\nID\n' + grayChars.join('');
        i = dataStart + dataLen;
        // EI 종결자 처리 ('\nEI' 또는 그냥 'EI')
        if (s[i] === '\n' && s[i+1] === 'E' && s[i+2] === 'I') { result += '\nEI'; i += 3; }
        else { result += '\nEI'; }
      } else if (!hasFilter && w > 0 && h > 0 && bpc === 8) {
        // 이미 그레이 또는 알 수 없는 CS — 바이너리 데이터 보호 후 그대로 통과
        const dataLen = w * h * channels;
        result += 'BI\n' + dictStr + '\nID\n' + s.slice(dataStart, dataStart + dataLen);
        i = dataStart + dataLen;
        if (s[i] === '\n' && s[i+1] === 'E' && s[i+2] === 'I') { result += '\nEI'; i += 3; }
        else { result += '\nEI'; }
      } else {
        // 필터 있음 또는 크기 불명 — heuristic으로 EI 탐색 후 그대로 통과
        let eiPos = dataStart;
        while (eiPos < s.length - 2) {
          if (s[eiPos] === '\n' && s[eiPos+1] === 'E' && s[eiPos+2] === 'I') {
            const after = eiPos + 3 < s.length ? s.charCodeAt(eiPos + 3) : 0;
            if (after <= 0x20 || after === 0x51 /*Q*/ || after === 0x71 /*q*/) break;
          }
          eiPos++;
        }
        result += 'BI\n' + dictStr + '\nID\n' + s.slice(dataStart, eiPos) + '\nEI';
        i = eiPos + 3;
      }
      segStart = i;
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
      const { jpegBytes, dotGain, lut } = payload;
      const jpegArr = new Uint8Array(jpegBytes);
      const jpegComps = getJpegComponentCount(jpegArr); // 3=YCbCr, 4=CMYK/YCCK
      let gray = null, iw, ih;

      // 방법 1: ImageDecoder
      try {
        if (typeof ImageDecoder !== 'undefined') {
          if (jpegComps === 3) {
            // 표준 YCbCr JPEG: colorSpaceConversion:'none' → I420 Y-플레인 직접 추출
            const decoder = new ImageDecoder({
              data: new ReadableStream({ start(ctrl) { ctrl.enqueue(jpegArr); ctrl.close(); } }),
              type: 'image/jpeg',
              colorSpaceConversion: 'none',
            });
            const { image: frame } = await decoder.decode();
            iw = frame.codedWidth; ih = frame.codedHeight;
            const buf = new ArrayBuffer(Math.ceil(iw * ih * 3 / 2));
            await frame.copyTo(buf, { format: 'I420' });
            frame.close(); decoder.close();
            gray = new Uint8Array(buf.slice(0, iw * ih));
          } else {
            // CMYK / YCCK (4ch, PowerPoint·InDesign): ICC 색상 보정 → RGBA 변환
            const decoder = new ImageDecoder({
              data: new ReadableStream({ start(ctrl) { ctrl.enqueue(jpegArr); ctrl.close(); } }),
              type: 'image/jpeg',
              colorSpaceConversion: 'default', // ICC 프로파일 적용하여 sRGB로 변환
            });
            const { image: frame } = await decoder.decode();
            iw = frame.codedWidth; ih = frame.codedHeight;
            const buf = new ArrayBuffer(iw * ih * 4);
            await frame.copyTo(buf, { format: 'RGBA' });
            frame.close(); decoder.close();
            const rgba = new Uint8Array(buf);
            gray = new Uint8Array(iw * ih);
            for (let pi = 0; pi < gray.length; pi++)
              gray[pi] = Math.round(0.299*rgba[pi*4] + 0.587*rgba[pi*4+1] + 0.114*rgba[pi*4+2]);
          }
        }
      } catch(e) { gray = null; }

      // 방법 2: OffscreenCanvas + BT.601 폴백
      if (!gray) {
        const blob = new Blob([jpegArr], { type: 'image/jpeg' });
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

      // Separation 틴트 LUT (메인 스레드에서 전달) — 픽셀값 t → 그레이 변환
      if (lut) { const tl = new Uint8Array(lut); for (let i = 0; i < gray.length; i++) gray[i] = tl[gray[i]]; }
      if (dotGain) { const dl = buildDotGainLUT(dotGain); for (let i = 0; i < gray.length; i++) gray[i] = dl[gray[i]]; }
      const predicted  = applyPNGPredictorGray(gray, iw, ih);
      const deflated   = pako.deflate(predicted, { level: 1 });
      // pako는 단일 청크일 때 내부 버퍼의 subarray를 반환할 수 있음
      // → .buffer.byteLength > .length 인 경우 PDF Length가 잘못 기록되어 파일이 열리지 않음
      // → slice()로 정확한 크기의 새 버퍼 생성
      const deflatedBuf = deflated.buffer.slice(deflated.byteOffset, deflated.byteOffset + deflated.length);
      self.postMessage({ id, result: { deflated: deflatedBuf, w: iw, h: ih } }, [deflatedBuf]);

    // ── FlateDecode RGB/CMYK → FlateDecode DeviceGray ──────────────────────
    } else if (type === 'flate2gray') {
      const { compressed, w, h, channels, predictor, dotGain, raw: isRaw } = payload;
      // isRaw: 비압축(Filter 없음) 픽셀 — inflate 생략
      // /Length 손상으로 잘린 스트림은 부분 복구 후 흰색으로 채움 (RGB 255 / CMYK 0)
      // predictor 행에는 행당 필터 바이트 1개 포함 + 채움값은 0 (유효한 필터 타입)
      const expLen = predictor >= 10 ? h * (w * channels + 1) : w * h * channels;
      const fill = predictor >= 10 ? 0 : (channels === 4 ? 0 : 255);
      let raw = isRaw
        ? new Uint8Array(compressed)
        : inflateLenientW(new Uint8Array(compressed), expLen, fill);
      if (!raw) { self.postMessage({ id, error: 'inflate_fail' }); return; }
      if (isRaw && raw.length < expLen) {
        const padded = new Uint8Array(expLen);
        padded.fill(fill);
        padded.set(raw, 0);
        raw = padded;
      }

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
      const deflated  = pako.deflate(predicted, { level: 1 });
      const deflatedBuf = deflated.buffer.slice(deflated.byteOffset, deflated.byteOffset + deflated.length);
      self.postMessage({ id, result: { deflated: deflatedBuf, w, h } }, [deflatedBuf]);

    // ── ICCBased FlateDecode → DeviceGray (PNG+iCCP → OffscreenCanvas ICC 보정) ──
    } else if (type === 'icc-flate2gray') {
      const { compressed, w, h, channels, predictor, iccBytes, dotGain, raw: isRaw2 } = payload;
      const expLen2 = predictor >= 10 ? h * (w * channels + 1) : w * h * channels;
      const fill2 = predictor >= 10 ? 0 : (channels === 4 ? 0 : 255);
      let raw = isRaw2
        ? new Uint8Array(compressed)
        : inflateLenientW(new Uint8Array(compressed), expLen2, fill2);
      if (!raw) { self.postMessage({ id, error: 'inflate_fail' }); return; }
      if (isRaw2 && raw.length < expLen2) {
        const padded = new Uint8Array(expLen2);
        padded.fill(fill2);
        padded.set(raw, 0);
        raw = padded;
      }

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
      const deflated  = pako.deflate(predicted, { level: 1 });
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
      // Phase A: 바이트 레벨에서 인라인 이미지(BI/EI) RGB→Gray 변환
      // grayifyStream보다 먼저 실행 — 바이너리 픽셀 데이터가 스트링 regex에 오염되지 않도록 격리
      try { raw = preprocessInlineImages(raw, dotGain || 0); } catch(e) { /* 실패해도 grayifyStream은 계속 */ }
      const processed = grayifyStream(raw, csGrayMap || {}, dotGain || 0);
      let out = processed;
      if (wasCompressed) out = pako.deflate(processed, { level: 1 });
      self.postMessage({ id, result: { bytes: out.buffer, length: out.length } }, [out.buffer]);

    } else {
      self.postMessage({ id, error: 'unknown_type' });
    }

  } catch(err) {
    self.postMessage({ id, error: String(err) });
  }
};
