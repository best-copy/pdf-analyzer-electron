/**
 * PDF 흑백변환 Web Worker
 * - JPEG → FlateDecode+DeviceGray
 * - FlateDecode RGB/CMYK → FlateDecode DeviceGray
 * - 컨텐츠 스트림 색상 연산자 그레이스케일 치환
 * OffscreenCanvas + pako 사용 (Electron Chromium 환경)
 */

importScripts('./libs/pako.min.js');
importScripts('./libs/jpeg-decoder.js');   // jpeg-js: Adobe CMYK/YCCK JPEG 정밀 디코드용
importScripts('./libs/gray-jpeg.js');      // 1성분(DeviceGray) JPEG 인코더 — 흑백 사진 재인코딩

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

// ── Adobe APP14 마커 존재 여부 ──────────────────────────────────────────────
// Adobe(Photoshop·InDesign) 계열 CMYK JPEG은 관례적으로 값이 '반전' 저장된다.
// PDF 렌더러(GS·pdfium·pdf.js)는 APP14를 보고 반전 해석하지만, Chromium의
// createImageBitmap은 반전을 적용하지 않고 디코드한다(Electron 31 실측 — 네거티브).
// → 4컴포넌트 + APP14 'Adobe' JPEG은 그레이 변환 후 255-v 반전이 필요하다.
function hasAdobeApp14(data) {
  if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
  if (data.length < 4 || data[0] !== 0xFF || data[1] !== 0xD8) return false;
  let i = 2;
  while (i + 3 < data.length) {
    if (data[i] !== 0xFF) { i++; continue; }
    const marker = data[i + 1];
    if (marker === 0xDA || marker === 0xD9) break; // SOS / EOI
    const segLen = (data[i+2] << 8) | data[i+3];
    if (marker === 0xEE && segLen >= 7 &&
        data[i+4] === 0x41 && data[i+5] === 0x64 && data[i+6] === 0x6F &&
        data[i+7] === 0x62 && data[i+8] === 0x65) return true;   // 'Adobe'
    i += 2 + segLen;
  }
  return false;
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
// Dot Gain 보정 곡선 — v: 밝기(0=검정·1=흰색) → 인쇄에서 망점이 번져 어두워질 것을 미리 밝게 한 값.
// 망점 번짐 모델: 인쇄 농도 = c + 4g·c·(1−c) (50% 망점에서 g만큼 더 진해짐) → 원하는 농도 t가 나오도록 c를 역산한다.
// gain: 0(보정 없음) · 10 · 15 · 20 (%) — 25는 예전 프리셋 호환(√v).
// ⚠ app-process.js dotGainCurve와 **같은 식**이어야 한다(scripts/test/gray-colorspace.test.js가 대조).
function dotGainCurve(v, gain) {
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  if (!gain) return v;
  if (gain === 25) return Math.sqrt(v);
  const g = gain / 100, t = 1 - v, b = 1 + 4 * g;
  const disc = b * b - 16 * g * t;
  const c = (b - Math.sqrt(disc < 0 ? 0 : disc)) / (8 * g);
  return 1 - (c < 0 ? 0 : c > 1 ? 1 : c);
}
function buildDotGainLUT(gain) {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(dotGainCurve(i / 255, gain) * 255);
  return lut;
}

// ── 인라인 이미지(BI … ID … EI) ─────────────────────────────────────────────
// PDF 규격의 구분자는 **아무 공백**(LF·CR·CRLF·스페이스·탭)이다. 예전에는 \nBI\n·\nID\n만 찾아서,
// CR 줄바꿈으로 만든 PDF(실측: 양졸당파 세계도 — 콘텐츠 스트림 전체가 \r)에서
//  ① 인라인 RGB 그림이 흑백으로 바뀌지 않았고(프린터 컬러 과금),
//  ② 문자열 단계가 'BI'를 인식한 뒤 \nID\n을 못 찾으면 'B' 한 글자를 버려 BI → I 로 깨졌다
//     → 그림의 바이너리 데이터가 페이지 명령으로 읽혀 Acrobat "이 페이지에 오류가 있습니다".
// 원칙: 경계를 **확신할 때만** 바꾸고, 조금이라도 애매하면 원본 바이트를 그대로 둔다.
const _isWS = b => b === 0x20 || b === 0x0A || b === 0x0D || b === 0x09 || b === 0x0C || b === 0x00;

// j 위치가 인라인 이미지 시작 토큰 BI인가 — 앞뒤가 공백이고, 이어지는 첫 글자가 '/'(사전 키)여야 한다.
// 괄호 문자열 속 여부는 모른다(바이트 단계는 문자열을 해석하지 않는다) — 그래서 변환하지 않는 그림은
// 원본 바이트를 그대로 복사해, 우연히 걸린 글자 문자열도 바뀌지 않게 한다.
function isInlineBIAt(raw, j) {
  if (raw[j] !== 0x42 || raw[j + 1] !== 0x49 || !_isWS(raw[j + 2]) || (j > 0 && !_isWS(raw[j - 1]))) return false;
  let k = j + 3;
  while (k < raw.length && _isWS(raw[k])) k++;
  return raw[k] === 0x2F;
}
// from부터 가장 가까운 BI 위치, 없으면 -1
function findInlineBI(raw, from) {
  for (let j = from; j <= raw.length - 3; j++) if (isInlineBIAt(raw, j)) return j;
  return -1;
}

// bi(= 'B' 위치)에서 시작하는 인라인 이미지 한 개의 경계와 속성 — 순수 함수 (scripts/test/inline-image.test.js).
// 성공: { ok:true, dict, dataStart, dataEnd, end(= 'EI' 다음), w, h, bpc, channels, isRGB, isCMYK,
//         hasFilter, hasDecode, imageMask, exact(길이로 확정), ambiguous(두 해석이 모두 성립) }
// 실패: { ok:false, next } — next 이전의 다른 BI 후보도 **같은 이유로 반드시 실패**하므로 부르는 쪽은
//       next부터 다시 찾는다(조작된 스트림에서 후보마다 끝까지 훑는 제곱 시간을 막는다). 바이트는 버리지 않는다.
function scanInlineImage(raw, bi) {
  const n = raw.length;
  let id = -1;
  for (let j = bi + 3; j <= n - 3; j++) {
    if (!_isWS(raw[j - 1]) || !_isWS(raw[j + 2])) continue;
    if (raw[j] === 0x49 && raw[j + 1] === 0x44) { id = j; break; }       // ID
    if (raw[j] === 0x45 && raw[j + 1] === 0x49) return { ok: false, next: j + 2 };   // ID보다 EI가 먼저 = BI가 아니다
  }
  if (id < 0) return { ok: false, next: n };                              // 끝까지 ID 없음 — 뒤의 BI도 마찬가지
  const dict = decodeLatin1(raw.subarray(bi + 3, id - 1));
  const num = (...keys) => { for (const k of keys) { const m = dict.match(new RegExp('\\/' + k + '\\s+(\\d+)')); if (m) return +m[1]; } return 0; };
  const cs = (dict.match(/\/(?:CS|ColorSpace)\s*(\/\w+|\[)/) || [])[1] || '';
  const imageMask = /\/(?:IM|ImageMask)\s+true/.test(dict);
  const w = num('W', 'Width'), h = num('H', 'Height');
  const bpc = imageMask ? 1 : (num('BPC', 'BitsPerComponent') || 8);
  const isRGB = ['/RGB', '/DeviceRGB', '/CalRGB'].includes(cs);
  const isCMYK = ['/CMYK', '/DeviceCMYK'].includes(cs);
  const channels = imageMask || ['/G', '/DeviceGray', '/CalGray', '/I', '/Indexed'].includes(cs) ? 1
    : isRGB ? 3 : isCMYK ? 4 : 0;                                          // 0 = 이름 붙은 색공간 등(크기 모름)
  const hasFilter = /\/(?:F|Filter)(?=[\s\/\[])/.test(dict);
  const hasDecode = /\/(?:D|Decode)(?=[\s\[])/.test(dict);
  const base = { ok: true, dict, w, h, bpc, channels, isRGB, isCMYK, hasFilter, hasDecode, imageMask };
  const dataStart = id + 3;
  // 데이터 끝 p 뒤에 (공백) EI (공백|끝|q|Q) 가 오면 'EI' 다음 위치, 아니면 -1
  const eiAt = p => {
    let k = p;
    while (k < n && _isWS(raw[k])) k++;
    const t = raw[k + 2];
    return (raw[k] === 0x45 && raw[k + 1] === 0x49 && (k + 2 >= n || _isWS(t) || t === 0x51 || t === 0x71)) ? k + 2 : -1;
  };
  // 비압축이고 크기를 알면 길이로 자른다 — 데이터 안에 우연히 " EI "가 있어도 속지 않는다.
  // ID 뒤가 CRLF인 파일(규격은 공백 1바이트)은 \n까지 건너뛴 해석도 본다. 두 해석이 **모두** 성립하면
  // (마지막 바이트가 0x00 같은 공백 값일 때) 어느 쪽인지 알 수 없으므로 ambiguous — 변환하지 않는다.
  if (!hasFilter && w > 0 && h > 0 && channels) {
    const len = Math.ceil(w * channels * bpc / 8) * h;
    const cands = [dataStart];
    if (raw[id + 2] === 0x0D && raw[id + 3] === 0x0A) cands.push(dataStart + 1);
    const hits = cands.map(ds => ({ ds, end: eiAt(ds + len) })).filter(x => x.end > 0);
    if (hits.length) return { ...base, dataStart: hits[0].ds, dataEnd: hits[0].ds + len, end: hits[0].end, exact: true, ambiguous: hits.length > 1 };
  }
  // 압축됐거나 크기를 모르면 — 공백 + EI + (공백|끝|q|Q)
  for (let k = dataStart; k <= n - 3; k++) {
    const t = raw[k + 3];
    if (_isWS(raw[k]) && raw[k + 1] === 0x45 && raw[k + 2] === 0x49 && (k + 3 >= n || _isWS(t) || t === 0x51 || t === 0x71))
      return { ...base, dataStart, dataEnd: k, end: k + 3, exact: false, ambiguous: false };
  }
  return { ok: false, next: n };                                          // EI가 끝까지 없음 — 뒤의 BI도 마찬가지
}

// 인라인 Indexed 색공간의 색상표(16진 문자열)를 회색으로 — 순수 함수. 바꿀 것이 없거나 모르면 null.
// (XObject Indexed의 app-process.js convertIndexedImagePalette와 같은 식: RGB는 BT.601 휘도, CMYK는 보색×(1-K))
function inlineIndexedToGray(dict) {
  const re = /(\/(?:CS|ColorSpace)\s*)\[\s*\/(?:I|Indexed)\s*\/(RGB|DeviceRGB|CMYK|DeviceCMYK)\s+(\d+)\s*<([0-9A-Fa-f\s]*)>\s*\]/;
  const m = dict.match(re);
  if (!m) return null;
  const nc = /RGB/.test(m[2]) ? 3 : 4, hival = +m[3];
  const hex = m[4].replace(/\s+/g, '');
  if (!(hival >= 0 && hival <= 255) || hex.length < (hival + 1) * nc * 2) return null;
  const b = i => parseInt(hex.substr(i * 2, 2), 16) / 255;
  let out = '';
  for (let i = 0; i <= hival; i++) {
    const o = i * nc;
    const g = nc === 3 ? 0.299 * b(o) + 0.587 * b(o + 1) + 0.114 * b(o + 2)
      : 0.299 * (1 - b(o)) * (1 - b(o + 3)) + 0.587 * (1 - b(o + 1)) * (1 - b(o + 3)) + 0.114 * (1 - b(o + 2)) * (1 - b(o + 3));
    out += Math.round(Math.max(0, Math.min(1, g)) * 255).toString(16).padStart(2, '0').toUpperCase();
  }
  return dict.replace(re, `${m[1]}[/I /G ${hival} <${out}>]`);
}

// 인라인 이미지를 바이트 단계에서 처리 — grayifyStream 이전에 실행한다.
//  · 비압축 8비트 RGB/CMYK이고 경계가 길이로 **확정**된 그림만 DeviceGray로 변환
//    (Decode 배열·ImageMask·경계가 애매한 그림은 성분 수나 위치가 틀어질 수 있어 그대로 둔다)
//  · 그 밖의 그림은 **원본 바이트를 그대로** 복사한다(구분자도 바꾸지 않는다)
// 변환한 그림이 하나도 없으면 원래 배열을 그대로 돌려준다.
function preprocessInlineImages(raw, dotGain) {
  const chunks = [];
  const lut = dotGain ? buildDotGainLUT(dotGain) : null;
  let pos = 0, j = 0;
  for (;;) {
    const bi = findInlineBI(raw, j);
    if (bi < 0) break;
    const img = scanInlineImage(raw, bi);
    if (!img.ok) { j = img.next; continue; }                   // 경계 불명 — 바이트를 버리지 않고 넘어간다
    j = img.end;
    // 사전 안에 색상표를 직접 적은 Indexed(/CS [/I /RGB 15 <…>]) — 색상표만 회색으로 바꾼다(픽셀·데이터 바이트는 그대로).
    // 예전엔 성분 수를 몰라 통째로 건너뛰어 컬러가 남았다(교안 PDF 실파일의 주황 아이콘).
    const palDict = inlineIndexedToGray(img.dict);
    if (palDict !== null) {
      const dictStart = bi + 3;
      chunks.push(raw.slice(pos, dictStart));
      chunks.push(encodeLatin1(palDict));
      pos = dictStart + img.dict.length;               // 사전 뒤(ID·데이터·EI)는 원본 바이트 그대로 복사된다
      continue;
    }
    const { w, h } = img;
    const ch = img.isRGB ? 3 : 4;
    if (!(img.exact && !img.ambiguous && !img.hasFilter && !img.hasDecode && !img.imageMask
          && (img.isRGB || img.isCMYK) && img.bpc === 8 && w > 0 && h > 0
          && img.dataEnd - img.dataStart === w * h * ch)) continue;   // 변환 대상 아님 — 원본 그대로(아래 pos 복사)
    chunks.push(raw.slice(pos, bi));
    const pix = raw.subarray(img.dataStart, img.dataEnd);
    const gray = new Uint8Array(w * h);
    if (img.isRGB) {
      for (let pi = 0; pi < w * h; pi++)
        gray[pi] = Math.round(0.299 * pix[pi * 3] + 0.587 * pix[pi * 3 + 1] + 0.114 * pix[pi * 3 + 2]);
    } else {
      for (let pi = 0; pi < w * h; pi++) {
        const c = pix[pi * 4] / 255, m2 = pix[pi * 4 + 1] / 255, y = pix[pi * 4 + 2] / 255, k = pix[pi * 4 + 3] / 255;
        gray[pi] = Math.round(255 * (0.299 * (1 - c) * (1 - k) + 0.587 * (1 - m2) * (1 - k) + 0.114 * (1 - y) * (1 - k)));
      }
    }
    if (lut) for (let pi = 0; pi < gray.length; pi++) gray[pi] = lut[gray[pi]];
    const newDict = img.dict.replace(/\/(CS|ColorSpace)\s*\/(RGB|DeviceRGB|CalRGB|CMYK|DeviceCMYK)/g, '/CS /G');
    chunks.push(encodeLatin1('BI\n' + newDict + '\nID\n'));
    chunks.push(gray);
    chunks.push(encodeLatin1('\nEI'));
    pos = img.end;
  }
  if (!chunks.length) return raw;
  chunks.push(raw.slice(pos));
  const total = chunks.reduce((t, c) => t + c.length, 0);
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

// ── 색 연산자 인식 (한 번에, 스트림 순서대로) ─────────────────────────────────
// 예전에는 연산자 종류마다 정규식을 따로 돌리고 성분 수(4·3·1)만 보고 색을 짐작했다. 그래서
//  · '/DeviceGray cs 0 sc'(이미 회색인 검정)를 별색 틴트로 보고 1-t = 흰색으로 뒤집었고 → 글자가 사라짐
//  · 성분 2개·5개(DeviceN)는 뒤쪽 숫자만 잡혀 '0.3 0.2000 g'처럼 피연산자가 남았고 → Acrobat 페이지 오류
//  · 한 조각 안에 cs가 여럿이면 마지막 cs 기준으로 모든 sc를 바꿨다.
// 이제는 cs/CS·q/Q·색 연산자를 나온 순서대로 읽어 '지금 색공간'을 따라가고, 색공간 정의(app-process.js
// buildCsDesc가 만든 설명자)로 **실제 색을 계산해** DeviceGray(g/G)로 바꾼다 — 별색·DeviceN은 변환 함수를,
// Indexed는 색 번호표를 풀어서. 정의를 끝내 모르면 성분 수로 추정해서라도 회색으로 바꾼다
// (색으로 남기면 프린터가 컬러로 과금한다). 원본대로 두는 것은 패턴 채우기 지정뿐 — 패턴 내용은 따로 변환된다.
// _LB: 좌측 경계. 패턴 이름(/P8, /Meta682 등) 내부의 숫자를 색상 틴트로 오매칭하면
//      '/P8 scn' → '/P-7.0000 g' 처럼 토큰이 깨져 Acrobat이 페이지 오류를 낸다.
//      → 숫자 토큰 앞이 이름/숫자 구성문자가 아닐 때만(공백·연산자 경계) 매칭.
const _NB = '-?\\d*\\.?\\d+', _TL = '(?=[\\s\\r\\n]|$)', _LB = '(?<![\\w/.#-])';
const _RE_OPS = new RegExp(
  '\\/([^\\s/\\[\\]<>(){}%]+)\\s+(cs|CS)' + _TL +                               // 1,2: /이름 cs
  '|' + _LB + '((?:' + _NB + '\\s+)*)(rg|RG|k|K|scn|SCN|sc|SC|g|G)' + _TL +     // 3,4: 숫자들 색연산자
  '|' + _LB + '(q|Q)' + _TL,                                                     // 5: 그래픽 상태 저장/복원
  'gm');
// 인라인 이미지에서 쓰는 약어·내장 색공간 이름 (리소스를 부르지 않는 것)
const _INLINE_CS_ABBR = new Set(['G', 'RGB', 'CMYK', 'I', 'DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Indexed', 'CalGray', 'CalRGB']);
// 리소스 없이 쓰는 내장 색공간 이름
const _DEVICE_CS = {
  DeviceGray: { kind: 'Gray', n: 1 }, CalGray: { kind: 'Gray', n: 1 },
  DeviceRGB: { kind: 'RGB', n: 3 }, CalRGB: { kind: 'RGB', n: 3 },
  DeviceCMYK: { kind: 'CMYK', n: 4 }, Pattern: { kind: 'Pattern' },
};

// ── PDF 함수·색공간 계산 ────────────────────────────────────────────────────────
// 설명자(desc)는 app-process.js buildCsDesc가 만든 순수 데이터(워커로 보낼 수 있게):
//  { kind:'Gray'|'RGB'|'CMYK'|'Lab'|'Pattern'|'Sep'|'DeviceN'|'Indexed'|'Unknown', n, fn, alt, base, hival, lookup }
//  fn: { t:0, domain, range, size, bps, encode, decode, samples } | { t:2, domain, range, c0, c1, N }
//    | { t:3, domain, range, fns, bounds, encode } | { t:4, domain, range, ops }
const _clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// PostScript 계산식(Type 4) — ops는 숫자·연산자 이름·'{' '}' 토큰 배열
function runPsCalc(ops, input) {
  const st = input.slice();
  const pop = () => st.pop();
  const matchBrace = (i, e) => { let d = 1, j = i + 1; for (; j < e && d; j++) { if (ops[j] === '{') d++; else if (ops[j] === '}') d--; } return j; }; // '}' 다음 위치
  const run = (s, e) => {
    for (let i = s; i < e; i++) {
      const t = ops[i];
      if (typeof t === 'number') { st.push(t); continue; }
      if (t === '{') {
        const j = matchBrace(i, e);                     // 첫 블록 [i+1, j-1)
        if (ops[j] === '{') {                           // cond {a} {b} ifelse
          const k = matchBrace(j, e);
          if (pop()) run(i + 1, j - 1); else run(j + 1, k - 1);
          i = k;                                        // ops[k] === 'ifelse'
        } else {                                        // cond {a} if
          if (pop()) run(i + 1, j - 1);
          i = j;                                        // ops[j] === 'if'
        }
        continue;
      }
      let a, b;
      switch (t) {
        case 'abs': st.push(Math.abs(pop())); break;
        case 'add': b = pop(); a = pop(); st.push(a + b); break;
        case 'sub': b = pop(); a = pop(); st.push(a - b); break;
        case 'mul': b = pop(); a = pop(); st.push(a * b); break;
        case 'div': b = pop(); a = pop(); st.push(b === 0 ? 0 : a / b); break;
        case 'idiv': b = pop(); a = pop(); st.push(b === 0 ? 0 : Math.trunc(a / b)); break;
        case 'mod': b = pop(); a = pop(); st.push(b === 0 ? 0 : a % b); break;
        case 'neg': st.push(-pop()); break;
        case 'ceiling': st.push(Math.ceil(pop())); break;
        case 'floor': st.push(Math.floor(pop())); break;
        case 'round': st.push(Math.round(pop())); break;
        case 'truncate': case 'cvi': st.push(Math.trunc(pop())); break;
        case 'cvr': break;
        case 'sqrt': st.push(Math.sqrt(Math.max(0, pop()))); break;
        case 'sin': st.push(Math.sin(pop() * Math.PI / 180)); break;
        case 'cos': st.push(Math.cos(pop() * Math.PI / 180)); break;
        case 'atan': b = pop(); a = pop(); { let r = Math.atan2(a, b) * 180 / Math.PI; if (r < 0) r += 360; st.push(r); } break;
        case 'exp': b = pop(); a = pop(); st.push(Math.pow(a, b)); break;
        case 'ln': st.push(Math.log(pop())); break;
        case 'log': st.push(Math.log10(pop())); break;
        case 'eq': b = pop(); a = pop(); st.push(a === b); break;
        case 'ne': b = pop(); a = pop(); st.push(a !== b); break;
        case 'gt': b = pop(); a = pop(); st.push(a > b); break;
        case 'ge': b = pop(); a = pop(); st.push(a >= b); break;
        case 'lt': b = pop(); a = pop(); st.push(a < b); break;
        case 'le': b = pop(); a = pop(); st.push(a <= b); break;
        case 'and': b = pop(); a = pop(); st.push(typeof a === 'boolean' ? a && b : a & b); break;
        case 'or': b = pop(); a = pop(); st.push(typeof a === 'boolean' ? a || b : a | b); break;
        case 'xor': b = pop(); a = pop(); st.push(typeof a === 'boolean' ? a !== b : a ^ b); break;
        case 'not': a = pop(); st.push(typeof a === 'boolean' ? !a : ~a); break;
        case 'bitshift': b = pop(); a = pop(); st.push(b >= 0 ? a << b : a >> -b); break;
        case 'true': st.push(true); break;
        case 'false': st.push(false); break;
        case 'pop': pop(); break;
        case 'dup': st.push(st[st.length - 1]); break;
        case 'exch': b = pop(); a = pop(); st.push(b, a); break;
        case 'copy': { const n = pop(); st.push(...st.slice(st.length - n)); break; }
        case 'index': { const n = pop(); st.push(st[st.length - 1 - n]); break; }
        case 'roll': {
          const j = pop(), n = pop();
          if (n > 0) { const part = st.splice(st.length - n, n); const s2 = ((j % n) + n) % n; st.push(...part.slice(n - s2), ...part.slice(0, n - s2)); }
          break;
        }
        default: throw new Error('ps op ' + t);
      }
    }
  };
  run(0, ops.length);
  return st.map(v => (typeof v === 'boolean' ? (v ? 1 : 0) : +v));
}

// 함수 설명자 → (입력 배열 → 출력 배열) 함수. 만들 수 없으면 null
function makePdfFn(fd) {
  if (!fd) return null;
  const dom = fd.domain || [0, 1];
  const clampIn = x => x.map((v, i) => _clamp(+v || 0, dom[2 * i] ?? 0, dom[2 * i + 1] ?? 1));
  const clampOut = y => (fd.range ? y.map((v, i) => (fd.range[2 * i] == null ? v : _clamp(v, fd.range[2 * i], fd.range[2 * i + 1]))) : y);
  if (fd.t === 2) {
    return x => { const t = clampIn(x)[0]; const tn = Math.pow(t, fd.N); return clampOut(fd.c0.map((c, i) => c + tn * ((fd.c1[i] ?? c) - c))); };
  }
  if (fd.t === 3) {
    const subs = (fd.fns || []).map(makePdfFn);
    if (subs.some(f => !f)) return null;
    return x => {
      const t = clampIn(x)[0], bd = fd.bounds || [];
      let k = 0; while (k < bd.length && t >= bd[k]) k++;
      const lo = k === 0 ? dom[0] : bd[k - 1], hi = k === bd.length ? dom[1] : bd[k];
      const e0 = fd.encode[2 * k], e1 = fd.encode[2 * k + 1];
      return clampOut(subs[k]([hi === lo ? e0 : e0 + (t - lo) * (e1 - e0) / (hi - lo)]));
    };
  }
  if (fd.t === 0) {
    const m = fd.size.length, nOut = fd.range.length / 2, maxS = Math.pow(2, fd.bps) - 1;
    const enc = fd.encode || fd.size.flatMap(s => [0, s - 1]);
    const dec = fd.decode || fd.range;
    const at = idx => { let off = 0, mul = 1; for (let i = 0; i < m; i++) { off += idx[i] * mul; mul *= fd.size[i]; } return off * nOut; };
    return x => {
      x = clampIn(x);
      const pos = x.map((v, i) => {
        const d0 = dom[2 * i], d1 = dom[2 * i + 1];
        return _clamp(enc[2 * i] + (d1 === d0 ? 0 : (v - d0) * (enc[2 * i + 1] - enc[2 * i]) / (d1 - d0)), 0, fd.size[i] - 1);
      });
      const out = new Array(nOut);
      if (m === 1) {                                  // 1차원(별색 틴트)은 선형 보간
        const i0 = Math.floor(pos[0]), i1 = Math.min(i0 + 1, fd.size[0] - 1), f = pos[0] - i0;
        const a = at([i0]), b = at([i1]);
        for (let j = 0; j < nOut; j++) out[j] = fd.samples[a + j] + f * (fd.samples[b + j] - fd.samples[a + j]);
      } else {                                        // 다차원은 가장 가까운 칸
        const o = at(pos.map(Math.round));
        for (let j = 0; j < nOut; j++) out[j] = fd.samples[o + j];
      }
      return clampOut(out.map((sv, j) => dec[2 * j] + sv * (dec[2 * j + 1] - dec[2 * j]) / maxS));
    };
  }
  if (fd.t === 4 && fd.ops) return x => clampOut(runPsCalc(fd.ops, clampIn(x)));
  return null;
}

// 성분 수만으로 추정 — 색공간 정의를 끝내 알 수 없을 때(그래도 회색으로 바꿔 프린터 컬러 과금을 막는다)
function guessGray(v) {
  if (v.length === 1) return _clamp(+v[0], 0, 1);
  if (v.length === 3) return _clamp(0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2], 0, 1);
  if (v.length === 4) return _clamp(0.299 * (1 - v[0]) * (1 - v[3]) + 0.587 * (1 - v[1]) * (1 - v[3]) + 0.114 * (1 - v[2]) * (1 - v[3]), 0, 1);
  return 1 - _clamp(v.reduce((s, x) => s + +x, 0), 0, 1);   // 여러 잉크 — 잉크 합이 많을수록 어둡게
}

// 색공간 설명자 + 성분 → 밝기 0~1. 정의대로 계산할 수 없으면 null
function csToGray(d, v) {
  if (!d) return null;
  v = v.map(Number);
  switch (d.kind) {
    case 'Gray': return v.length === 1 ? _clamp(v[0], 0, 1) : null;
    case 'RGB': return v.length === 3 ? _clamp(0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2], 0, 1) : null;
    case 'CMYK': return v.length === 4 ? guessGray(v) : null;
    case 'Lab': return v.length === 3 ? _clamp(v[0] / 100, 0, 1) : null;   // L* 0~100
    case 'XYZ': return v.length === 3 ? _clamp(v[1], 0, 1) : null;         // Y = 휘도
    case 'Sep': case 'DeviceN': {
      if (v.length !== (d.n || 1)) return null;
      if (d.fn && d._fn === undefined) { try { d._fn = makePdfFn(d.fn); } catch (e) { d._fn = null; } }
      if (d._fn) {
        try { const g = csToGray(d.alt, d._fn(v)); if (g != null && isFinite(g)) return g; } catch (e) { d._fn = null; }
      }
      return 1 - _clamp(v.reduce((s, x) => s + x, 0), 0, 1);             // 변환 함수를 못 풀면 잉크 양으로
    }
    case 'Indexed': {
      const nb = d.base && d.base.n;
      if (v.length !== 1 || !nb || !d.lookup) return null;
      const idx = _clamp(Math.round(v[0]), 0, d.hival | 0);
      const comps = [];
      for (let j = 0; j < nb; j++) comps.push((d.lookup[idx * nb + j] || 0) / 255);
      if (d.base.kind === 'Lab') { comps[0] *= 100; }                     // 번호표 바이트 → L* 범위
      return csToGray(d.base, comps);
    }
  }
  return null;
}

// csGrayMap: { '/이름': 색공간 설명자 } (app-process.js buildCsDesc)
// info(선택): { stat: {} } — guessed(정의를 몰라 성분 수로 추정한 색 연산자 수) 등을 모은다.
function grayifyStream(bytes, csGrayMap, dotGain, info) {
  const s = decodeLatin1(bytes);
  // dotGain 보정 함수 (0-1 범위, 0=검정 1=흰색)
  const dgApply = (v) => dotGainCurve(v, dotGain);
  // BT.601 휘도: JPEG Y채널 공식과 일치 → 이미지·벡터 동일 기준
  const lum = (r, g, b) => dgApply(0.299*+r + 0.587*+g + 0.114*+b).toFixed(4);
  const lumCmyk = (c, m, y, k) => {
    const R = (1-+c)*(1-+k), G = (1-+m)*(1-+k), B = (1-+y)*(1-+k);
    return dgApply(0.299*R + 0.587*G + 0.114*B).toFixed(4);
  };

  // 지금 채우기·선 색공간 { name, d(설명자) } — q/Q로 저장·복원된다(색공간은 그래픽 상태의 일부)
  const DEV_GRAY = { name: 'DeviceGray', d: _DEVICE_CS.DeviceGray };
  let fill = DEV_GRAY, stroke = DEV_GRAY;
  const gsStack = [];
  const stat = (info && info.stat) || {};
  const bump = k => { stat[k] = (stat[k] || 0) + 1; };
  // 명명 색공간 이름 → 설명자. 리소스에 없는 이름은 Unknown(성분 수로 추정)
  const descOf = name => (csGrayMap && csGrayMap['/' + name]) || _DEVICE_CS[name] || { kind: 'Unknown' };
  const f4 = v => dgApply(_clamp(+v, 0, 1)).toFixed(4);
  // cs 직후의 초기색(규격) — 별색·DeviceN은 틴트 1(잉크 가득), Indexed는 0번, 나머지는 검정
  const initialGray = d => {
    if (d.kind === 'Sep' || d.kind === 'DeviceN') { const g = csToGray(d, new Array(d.n || 1).fill(1)); return f4(g == null ? 0 : g); }
    if (d.kind === 'Indexed') { const g = csToGray(d, [0]); return f4(g == null ? 0 : g); }
    return '0.0000';
  };

  const applyOps = seg => seg.replace(_RE_OPS, (m, csName, csOp, nums, op, qop) => {
    if (qop) {
      if (qop === 'q') gsStack.push([fill, stroke]);
      else if (gsStack.length) [fill, stroke] = gsStack.pop();
      return m;
    }
    if (csOp) {
      const cs = { name: csName, d: descOf(csName) };
      const isStroke = csOp === 'CS';
      if (isStroke) stroke = cs; else fill = cs;
      // 패턴은 원본 유지 — 지우면 뒤따르는 '/P0 scn' 패턴 호출이 깨진다(패턴 내용은 따로 회색으로 바뀐다)
      if (cs.d.kind === 'Pattern') return m;
      // 그 밖의 색공간 지정은 없애고 초기색을 회색 연산자로 — 뒤따르는 sc/scn은 아래에서 g/G로 바뀐다
      return initialGray(cs.d) + (isStroke ? ' G' : ' g');
    }
    const isStroke = op === op.toUpperCase();
    const G = isStroke ? 'G' : 'g';
    const v = nums ? nums.trim().split(/\s+/) : [];
    const lower = op.toLowerCase();
    if (lower === 'g' || lower === 'rg' || lower === 'k') {
      if (isStroke) stroke = DEV_GRAY; else fill = DEV_GRAY;           // 장치 색 연산자 뒤에는 DeviceGray
      if (lower === 'g') return m;                                      // 이미 회색
      if (v.length !== (lower === 'rg' ? 3 : 4)) return m;              // 피연산자 수가 틀린 원본 — 손대지 않음
      return (lower === 'rg' ? lum(v[0], v[1], v[2]) : lumCmyk(v[0], v[1], v[2], v[3])) + ' ' + G;
    }
    // sc/scn — 지금 색공간의 정의로 실제 색을 계산한다
    const cs = isStroke ? stroke : fill;
    if (!v.length) return m;                                            // '/P0 scn' 같은 패턴 호출
    if (cs.d.kind === 'Pattern') return m;                              // 무채색 패턴의 성분(뒤에 이름이 붙음) — 여기 오지 않지만 방어
    let g = csToGray(cs.d, v);
    if (g == null) { g = guessGray(v); bump('guessed'); }               // 정의를 모름 — 성분 수로 추정
    if (isStroke) stroke = DEV_GRAY; else fill = DEV_GRAY;
    return f4(g) + ' ' + G;
  });

  let result = '', i = 0, segStart = 0;
  let biSkipUntil = 0;   // 이 위치 전의 BI 후보는 경계를 못 찾는 것이 확정됨(scanInlineImage의 next)
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
    } else if (ch === '%') {
      // 주석 — 줄 끝까지 그대로 (주석 속의 '(' 가 뒤쪽 전체를 문자열로 오인시키지 않게)
      result += applyOps(s.slice(segStart, i));
      let j = i + 1;
      while (j < s.length && s[j] !== '\n' && s[j] !== '\r') j++;
      result += s.slice(i, j);
      i = j; segStart = i;
    } else if (ch === '<' && (i + 1 >= s.length || s[i + 1] !== '<')) {
      const end = s.indexOf('>', i + 1);
      if (end >= 0) {
        result += applyOps(s.slice(segStart, i));
        result += s.slice(i, end + 1);
        i = end + 1; segStart = i;
      } else { i++; }
    } else if (ch === 'B' && i >= biSkipUntil && isInlineBIAt(bytes, i)) {
      // ── 인라인 이미지 (BI … ID … EI) ──────────────────────────────────────
      // 바이너리 데이터가 색상 치환 정규식에 걸리지 않게 통째로 보호한다.
      // (RGB/CMYK → 회색 변환은 앞 단계 preprocessInlineImages가 이미 했다)
      const img = scanInlineImage(bytes, i);
      if (!img.ok) { biSkipUntil = img.next; i++; continue; }   // 인라인 이미지가 아니다 — segStart를 그대로 둬 글자를 버리지 않는다
      result += applyOps(s.slice(segStart, i));
      // 변환하지 못한 인라인 이미지가 명명 색공간(/CS /CS1 — 흔히 Indexed)을 부르면 그 리소스는 지우면 안 된다
      const csRef = (img.dict.match(/\/(?:CS|ColorSpace)\s*\/([^\s/\[\]<>(){}%]+)/) || [])[1];
      if (csRef && !_INLINE_CS_ABBR.has(csRef)) (stat.inlineCS = stat.inlineCS || []).push(csRef);
      result += s.slice(i, img.end);
      i = img.end;
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

      // 방법 0: CMYK/YCCK(4comp)는 jpeg-js JpegImage로 '정밀' 디코드.
      // Chromium 네이티브 디코더는 Adobe CMYK를 잘못 변환해 계조가 깨지고(네거티브),
      // jpeg-js 내장 CMYK→RGB(copyToImageData)도 관례와 어긋난다(GS 대비 오차 118/255).
      // → getData의 raw 산출을 받아 GS 정답으로 캘리브레이션한 공식을 직접 적용(오차 8/255).
      // 0.4.4 getData(4comp) 산출 semantics:
      //   YCCK(transform=2):  [R_ycc, G_ycc, B_ycc, 255-K_raw]  (R_ycc = 보색휘도 = 255-C_true)
      //   분리 CMYK(그 외):    [C_true, M_true, Y_true, 255-K_raw]
      // data[3] = 255-K_raw = K의 밝기 계수(1-K). 검증식: gray = lum(보색채널) × data[3]/255
      if (jpegComps === 4 && typeof JpegImage === 'function') {
        try {
          JpegImage.resetMaxMemoryUsage(4096 * 1024 * 1024);
          const j = new JpegImage();
          j.opts = { colorTransform: undefined, tolerantDecoding: true,
                     maxResolutionInMP: 400, maxMemoryUsageInMB: 4096 };
          j.parse(jpegArr);
          iw = j.width; ih = j.height;
          const d4 = j.getData(iw, ih);   // 4바이트/px
          const ycck = !!(j.adobe && j.adobe.transformCode === 2);
          gray = new Uint8Array(iw * ih);
          for (let pi = 0; pi < gray.length; pi++) {
            const o = pi * 4;
            // 보색(밝기 방향) 채널: YCCK는 그대로, 분리 CMYK는 255-값
            const r = ycck ? d4[o]     : 255 - d4[o];
            const g = ycck ? d4[o + 1] : 255 - d4[o + 1];
            const b = ycck ? d4[o + 2] : 255 - d4[o + 2];
            const L = 0.299 * r + 0.587 * g + 0.114 * b;
            gray[pi] = Math.round(L * d4[o + 3] / 255);
          }
        } catch (e) { gray = null; }   // 실패 시 아래 근사 경로(방법 2 + 반전 보정) 폴백
      }

      // 방법 1: ImageDecoder — 표준 YCbCr(3comp)만. CMYK(4comp)는 환경별 반전 처리가
      // 제각각이라(이중 반전 위험) 항상 방법 2 + 명시적 반전 보정으로 처리한다.
      try {
        if (!gray && typeof ImageDecoder !== 'undefined' && jpegComps === 3) {
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
        // ★ Adobe 반전 CMYK 보정: Photoshop 계열 CMYK JPEG(APP14 'Adobe')은 값이
        // 반전 저장되는데 Chromium 디코더는 반전을 적용하지 않아 네거티브로 나온다.
        // (증상: 변환 결과 사진이 필름 음화처럼 반전 — 옥산서원 문서로 실측 확인)
        if (jpegComps === 4 && hasAdobeApp14(jpegArr)) {
          for (let pi = 0; pi < gray.length; pi++) gray[pi] = 255 - gray[pi];
        }
      }

      // Separation 틴트 LUT (메인 스레드에서 전달) — 픽셀값 t → 그레이 변환
      if (lut) { const tl = new Uint8Array(lut); for (let i = 0; i < gray.length; i++) gray[i] = tl[gray[i]]; }
      if (dotGain) { const dl = buildDotGainLUT(dotGain); for (let i = 0; i < gray.length; i++) gray[i] = dl[gray[i]]; }

      // ★ 용량 최적화: 원본이 JPEG(사진)이므로 흑백도 JPEG(DCTDecode)로 재인코딩.
      // 픽셀을 Flate로 재압축하면 JPEG 압축이 사라져 원본보다 약 2배 커진다(실측 177~213%).
      // 1성분(DeviceGray) JPEG — 예전엔 캔버스로 R=G=B RGB JPEG를 만들었는데, 프린터·gs inkcov가 CMY를
      // 잡아 컬러로 셀 수 있었다. 1성분은 같은 q82에서 화질 같고 용량은 94%(실측 158장). (실패 시 Flate 폴백)
      try {
        const jb = encodeGrayJpeg(gray, iw, ih, 82);
        const jpegBuf = jb.buffer.slice(jb.byteOffset, jb.byteOffset + jb.length);
        self.postMessage({ id, result: { jpeg: jpegBuf, w: iw, h: ih } }, [jpegBuf]);
        return;
      } catch (encErr) { /* JPEG 인코딩 실패 → Flate 폴백 */ }

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
      const info = { stat: {} };
      const processed = grayifyStream(raw, csGrayMap || {}, dotGain || 0, info);
      let out = processed;
      if (wasCompressed) out = pako.deflate(processed, { level: 1 });
      self.postMessage({ id, result: { bytes: out.buffer, length: out.length, stat: info.stat } }, [out.buffer]);

    } else {
      self.postMessage({ id, error: 'unknown_type' });
    }

  } catch(err) {
    self.postMessage({ id, error: String(err) });
  }
};
