// 벡터 grayify만 p2에 적용 — 검정 블록 원인이 벡터 변환인지 확인
// worker-gray.js의 grayifyStream/preprocessInlineImages를 Node.js에서 직접 실행
const PDFLib = require('./src/libs/pdf-lib.min.js');
const pako   = require('./src/libs/pako.min.js');
const fs     = require('fs');
const Nm     = n => PDFLib.PDFName.of(n);

// ── worker-gray.js에서 가져온 함수들 ──────────────────────────────────────────
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
  const dgApply = (v) => {
    if (!dotGain) return v;
    const vv = Math.max(0, Math.min(1, v));
    if (dotGain === 25) return Math.sqrt(vv);
    return vv;
  };
  const lum = (r, g, b) => dgApply(0.299*+r + 0.587*+g + 0.114*+b).toFixed(4);
  const lumCmyk = (c, m, y, k) => {
    const R = (1-+c)*(1-+k), G = (1-+m)*(1-+k), B = (1-+y)*(1-+k);
    return dgApply(0.299*R + 0.587*G + 0.114*B).toFixed(4);
  };
  const tintToGray = (csInfo, t) => {
    const tv = +t;
    const tN = Math.pow(tv, csInfo.N);
    const ch = csInfo.c0.map((c0v, i) => c0v + tN * (csInfo.c1[i] - c0v));
    const alt = csInfo.altName;
    if (alt === '/DeviceCMYK' && ch.length >= 4) return lumCmyk(ch[0], ch[1], ch[2], ch[3]);
    else if (alt === '/DeviceRGB' && ch.length >= 3) return lum(ch[0], ch[1], ch[2]);
    else if (alt === '/DeviceGray' && ch.length >= 1) return dgApply(+ch[0]).toFixed(4);
    return dgApply(1 - tv).toFixed(4);
  };

  let fillCS = null, strokeCS = null;

  const applyOps = seg => {
    seg = seg.replace(/\/(\w+)\s+cs(?=[\s\r\n]|$)/gm, (_, name) => {
      fillCS = '/' + name;
      const info = csGrayMap && csGrayMap['/' + name];
      if (info && info.type === 'Pattern') return `/${name} cs`;
      return '';
    });
    seg = seg.replace(/\/(\w+)\s+CS(?=[\s\r\n]|$)/gm, (_, name) => {
      strokeCS = '/' + name;
      const info = csGrayMap && csGrayMap['/' + name];
      if (info && info.type === 'Pattern') return `/${name} CS`;
      return '';
    });
    seg = seg.replace(_RE_rg, (_, r, g, b) => `${lum(r,g,b)} g`);
    seg = seg.replace(_RE_RG, (_, r, g, b) => `${lum(r,g,b)} G`);
    seg = seg.replace(_RE_k, (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} g`);
    seg = seg.replace(_RE_K, (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} G`);
    seg = seg.replace(_RE_SCN4, (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} G`);
    seg = seg.replace(_RE_scn4, (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} g`);
    seg = seg.replace(_RE_SC4,  (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} G`);
    seg = seg.replace(_RE_sc4,  (_, c, m, y, k) => `${lumCmyk(c,m,y,k)} g`);
    seg = seg.replace(_RE_SCN3, (_, r, g, b) => `${lum(r,g,b)} G`);
    seg = seg.replace(_RE_scn3, (_, r, g, b) => `${lum(r,g,b)} g`);
    seg = seg.replace(_RE_SC3,  (_, r, g, b) => `${lum(r,g,b)} G`);
    seg = seg.replace(_RE_sc3,  (_, r, g, b) => `${lum(r,g,b)} g`);
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
      result += applyOps(s.slice(segStart, i));
      const idIdx = s.indexOf('\nID\n', i + 3);
      if (idIdx < 0) { i++; segStart = i; continue; }
      const dictStr = s.slice(i + 3, idIdx);
      // BI...EI 영역 통과
      const biGetNum = (d, ...keys) => { for (const k of keys) { const m = d.match(new RegExp('\\/' + k + '\\s+(\\d+)')); if (m) return +m[1]; } return 0; };
      const biGetCS  = (d) => { const m = d.match(/\/(CS|ColorSpace)\s+\/(\w+)/); return m ? '/' + m[2] : ''; };
      const biGetF   = (d) => { const m = d.match(/\/(F(?:ilter)?)\s+\/(\w+)/); return m ? '/' + m[2] : ''; };
      const w = biGetNum(dictStr,'W','Width'), h = biGetNum(dictStr,'H','Height');
      const bpc = biGetNum(dictStr,'BPC','BitsPerComponent')||8;
      const csName = biGetCS(dictStr), filterName = biGetF(dictStr);
      const isRGB  = ['/RGB','/DeviceRGB','/CalRGB'].includes(csName);
      const isCMYK = ['/CMYK','/DeviceCMYK'].includes(csName);
      const hasFilter = filterName !== '' && filterName !== '/None';
      const channels  = isCMYK ? 4 : isRGB ? 3 : 1;
      const dataStart = idIdx + 4;
      if (!hasFilter && (isRGB || isCMYK) && bpc === 8 && w > 0 && h > 0) {
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
        if (s[i] === '\n' && s[i+1] === 'E' && s[i+2] === 'I') { result += '\nEI'; i += 3; }
        else { result += '\nEI'; }
      } else if (!hasFilter && w > 0 && h > 0 && bpc === 8) {
        const dataLen = w * h * channels;
        result += 'BI\n' + dictStr + '\nID\n' + s.slice(dataStart, dataStart + dataLen);
        i = dataStart + dataLen;
        if (s[i] === '\n' && s[i+1] === 'E' && s[i+2] === 'I') { result += '\nEI'; i += 3; }
        else { result += '\nEI'; }
      } else {
        let eiPos = dataStart;
        while (eiPos < s.length - 2) {
          if (s[eiPos] === '\n' && s[eiPos+1] === 'E' && s[eiPos+2] === 'I') {
            const after = eiPos + 3 < s.length ? s.charCodeAt(eiPos + 3) : 0;
            if (after <= 0x20 || after === 0x51 || after === 0x71) break;
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

// ── 메인 ──────────────────────────────────────────────────────────────────────
(async () => {
  const pdfDoc = await PDFLib.PDFDocument.load(
    fs.readFileSync('D:/바탕화면/test_원본.pdf'),
    { ignoreEncryption: true, throwOnInvalidObject: false });
  const ctx = pdfDoc.context;
  const lk  = v => (v == null ? v : (ctx.lookup(v) ?? v));

  const resolveFilterName = (filterVal) => {
    if (!filterVal) return '';
    if (filterVal.encodedName) return filterVal.encodedName;
    if (typeof filterVal.size === 'function' && filterVal.size() === 1) {
      try { const f = lk(filterVal.get(0)); return f && f.encodedName ? f.encodedName : ''; } catch(e) {}
    }
    return '';
  };

  let streamCount = 0, errCount = 0;

  // 전체 페이지 콘텐츠 스트림에 grayifyStream 적용
  for (let pgIdx = 0; pgIdx < pdfDoc.getPageCount(); pgIdx++) {
    const page = pdfDoc.getPage(pgIdx);
    const node = page.node;
    const contentsVal = node.get(Nm('Contents'));
    if (!contentsVal) continue;
    const contentsObj = lk(contentsVal);

    const processStream = (streamObj) => {
      if (!streamObj || !streamObj.contents) return;
      const filter = streamObj.dict.get(Nm('Filter'));
      const fn = resolveFilterName(filter);
      let wasCompressed = false;
      if (filter) {
        if (fn === '/FlateDecode' || fn === '/Fl') wasCompressed = true;
        else return; // 다른 필터는 건너뜀
      }
      try {
        let raw = streamObj.contents;
        if (wasCompressed) raw = pako.inflate(raw);
        const out = grayifyStream(raw, {}, 0);
        const compressed = wasCompressed ? pako.deflate(out, { level: 1 }) : out;
        streamObj.contents = compressed;
        try { streamObj.dict.set(Nm('Length'), PDFLib.PDFNumber.of(compressed.length)); } catch(e) {}
        streamCount++;
      } catch(e) { errCount++; }
    };

    if (contentsObj && typeof contentsObj.size === 'function') {
      for (let i = 0; i < contentsObj.size(); i++) processStream(lk(contentsObj.get(i)));
    } else {
      processStream(contentsObj);
    }
  }

  console.log(`스트림 처리: ${streamCount}개, 오류: ${errCount}개`);
  const out = await pdfDoc.save({ useObjectStreams: false });
  fs.writeFileSync('D:/바탕화면/test_vector_only.pdf', out);
  console.log('저장: D:/바탕화면/test_vector_only.pdf', Math.round(out.length / 1024), 'KB');
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
