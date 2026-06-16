// 변환된 PDF에서 칼라 잔류 객체 탐지
const PDFLib = require('./src/libs/pdf-lib.min.js');
const pako = require('./src/libs/pako.min.js');
const fs = require('fs');

const file = process.argv[2];
const Nm = (n) => PDFLib.PDFName.of(n);

(async () => {
  const bytes = fs.readFileSync(file);
  const pdfDoc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false });
  const ctx = pdfDoc.context;
  const lk = (v) => (v == null ? v : (ctx.lookup(v) ?? v));
  const num = (v) => { const o = lk(v); const n = o?.numberValue ?? o?.asNumber?.(); return n != null ? +n : null; };

  const csName = (csRef) => {
    const cs = lk(csRef);
    if (!cs) return '(none)';
    if (cs.encodedName) return cs.encodedName;
    if (typeof cs.size === 'function' && cs.size() > 0) {
      const first = lk(cs.get(0));
      const fn = first?.encodedName || '?';
      if (fn === '/ICCBased') {
        const st = lk(cs.get(1));
        const n = num(st?.dict?.get?.(Nm('N')));
        return `[/ICCBased N=${n}]`;
      }
      if (fn === '/Indexed') {
        const base = lk(cs.get(1));
        return `[/Indexed base=${base?.encodedName || csName(cs.get(1))}]`;
      }
      if (fn === '/Separation' || fn === '/DeviceN') {
        return `[${fn} alt=${csName(cs.get(2))}]`;
      }
      return `[${fn} size=${cs.size()}]`;
    }
    return '(?)';
  };
  const isGrayCS = (s) => s === '/DeviceGray' || s === '/CalGray' || s === '[/ICCBased N=1]' || s === '(none)';

  const getStreamData = (st) => {
    if (!st || !st.contents) return null;
    const f = st.dict.get(Nm('Filter'));
    const fname = (() => {
      const fo = lk(f);
      if (!fo) return '';
      if (fo.encodedName) return fo.encodedName;
      if (typeof fo.size === 'function' && fo.size() > 0) return lk(fo.get(0))?.encodedName || '';
      return '';
    })();
    if (fname === '/FlateDecode' || fname === '/Fl') {
      try { return pako.inflate(st.contents); } catch (e) { return null; }
    }
    if (fname === '') return st.contents;
    return null;
  };

  // 콘텐츠 스트림에서 칼라 연산자 탐지
  const scanOps = (data) => {
    if (!data) return [];
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < data.length; i += CH) s += String.fromCharCode.apply(null, data.subarray(i, i + CH));
    const found = new Map();
    const add = (k, sample) => { if (!found.has(k)) found.set(k, { count: 0, sample }); found.get(k).count++; };
    // 문자열 리터럴 제거 후 검사 (오탐 방지)
    const clean = s.replace(/\((?:[^()\\]|\\.)*\)/g, '()').replace(/<[0-9A-Fa-f\s]*>/g, '<>');
    let m;
    const reRG = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(rg|RG)(?=[\s\r\n])/g;
    while ((m = reRG.exec(clean))) { if (Math.abs(m[1]-m[2])>0.01||Math.abs(m[2]-m[3])>0.01) add('rg/RG(비회색)', m[0]); }
    const reK = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(k|K)(?=[\s\r\n])/g;
    while ((m = reK.exec(clean))) { if (+m[1]>0.01||+m[2]>0.01||+m[3]>0.01) add('k/K(비회색)', m[0]); }
    const reSCN = /((?:-?[\d.]+\s+)+)(scn|SCN|sc|SC)(?=[\s\r\n])/g;
    while ((m = reSCN.exec(clean))) {
      const nums = m[1].trim().split(/\s+/).map(Number);
      if (nums.length === 3 && (Math.abs(nums[0]-nums[1])>0.01||Math.abs(nums[1]-nums[2])>0.01)) add('scn 3인수(비회색)', m[0].trim());
      if (nums.length === 4 && (nums[0]>0.01||nums[1]>0.01||nums[2]>0.01)) add('scn 4인수(비회색)', m[0].trim());
    }
    const reCS = /\/(\w+)\s+(cs|CS)(?=[\s\r\n])/g;
    while ((m = reCS.exec(clean))) add(`cs연산자(/${m[1]})`, m[0]);
    const rePat = /\/(\w+)\s+(scn|SCN)(?=[\s\r\n])/g;
    while ((m = rePat.exec(clean))) add(`패턴호출(/${m[1]})`, m[0]);
    if (/(^|[\s\r\n])BI[\s\r\n]/.test(clean)) add('인라인이미지(BI)', 'BI...');
    if (/[\s\r\n]sh[\s\r\n]/.test(clean)) add('sh연산자', 'sh');
    return [...found.entries()];
  };

  const pages = pdfDoc.getPages();
  console.log(`총 ${pages.length}페이지 분석 시작`);
  const report = {};
  const seen = new Set();

  const inspectResources = (resDict, pageIdx, where, depth) => {
    if (!resDict || depth > 5) return;
    const add = (msg) => { (report[pageIdx + 1] ??= new Set()).add(msg); };
    // XObjects
    const xo = lk(resDict.get(Nm('XObject')));
    if (xo && typeof xo.entries === 'function') {
      for (const [nameObj, ref] of xo.entries()) {
        const key = ref?.objectNumber != null ? `${ref.objectNumber}` : null;
        const obj = lk(ref);
        if (!obj || !obj.dict) continue;
        const sub = obj.dict.get(Nm('Subtype'))?.encodedName;
        if (sub === '/Image') {
          const cn = csName(obj.dict.get(Nm('ColorSpace')));
          const im = obj.dict.get(Nm('ImageMask'));
          if (!isGrayCS(cn) && !im) {
            const filt = lk(obj.dict.get(Nm('Filter')));
            const fn = filt?.encodedName || (typeof filt?.size === 'function' ? lk(filt.get(0))?.encodedName : '') || '';
            add(`${where}이미지 ${nameObj.encodedName || nameObj} CS=${cn} Filter=${fn} obj#${key}`);
          }
        } else if (sub === '/Form') {
          if (key && seen.has('f' + key)) continue;
          if (key) seen.add('f' + key);
          const data = getStreamData(obj);
          for (const [k, v] of scanOps(data)) add(`${where}Form내 ${k} ×${v.count} (예: ${v.sample.slice(0, 40)})`);
          const fr = lk(obj.dict.get(Nm('Resources')));
          inspectResources(fr, pageIdx, where + 'Form>', depth + 1);
        }
      }
    }
    // Shading
    const sh = lk(resDict.get(Nm('Shading')));
    if (sh && typeof sh.entries === 'function') {
      for (const [nameObj, ref] of sh.entries()) {
        const obj = lk(ref);
        const d = obj?.dict || obj;
        if (!d?.get) continue;
        const st = num(d.get(Nm('ShadingType')));
        const cn = csName(d.get(Nm('ColorSpace')));
        if (!isGrayCS(cn)) add(`${where}Shading ${nameObj.encodedName} Type=${st} CS=${cn}`);
      }
    }
    // Pattern
    const pat = lk(resDict.get(Nm('Pattern')));
    if (pat && typeof pat.entries === 'function') {
      for (const [nameObj, ref] of pat.entries()) {
        const obj = lk(ref);
        const d = obj?.dict || obj;
        if (!d?.get) continue;
        const pt = num(d.get(Nm('PatternType')));
        if (pt === 2) {
          const shd = lk(d.get(Nm('Shading')));
          const sd = shd?.dict || shd;
          const st = sd?.get ? num(sd.get(Nm('ShadingType'))) : null;
          const cn = sd?.get ? csName(sd.get(Nm('ColorSpace'))) : '?';
          if (!isGrayCS(cn)) add(`${where}ShadingPattern ${nameObj.encodedName} Type=${st} CS=${cn}`);
        } else if (pt === 1) {
          const data = getStreamData(obj);
          for (const [k, v] of scanOps(data)) add(`${where}TilingPattern내 ${k} ×${v.count}`);
          const pr = lk(obj.dict?.get(Nm('Resources')));
          inspectResources(pr, pageIdx, where + 'Tile>', depth + 1);
        }
      }
    }
    // ExtGState SMask
    const eg = lk(resDict.get(Nm('ExtGState')));
    if (eg && typeof eg.entries === 'function') {
      for (const [, ref] of eg.entries()) {
        const gs = lk(ref);
        if (!gs?.get) continue;
        const sm = lk(gs.get(Nm('SMask')));
        if (!sm?.get) continue;
        const g = lk(sm.get(Nm('G')));
        if (!g?.dict) continue;
        const key = 'g' + (sm.get(Nm('G'))?.objectNumber ?? Math.random());
        if (seen.has(key)) continue;
        seen.add(key);
        const data = getStreamData(g);
        for (const [k, v] of scanOps(data)) add(`${where}SMask내 ${k} ×${v.count}`);
        const gr = lk(g.dict.get(Nm('Resources')));
        inspectResources(gr, pageIdx, where + 'SMask>', depth + 1);
      }
    }
  };

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    const node = page.node;
    // 페이지 콘텐츠 스트림
    const contents = lk(node.get(Nm('Contents')));
    const streams = [];
    if (contents && typeof contents.size === 'function') {
      for (let i = 0; i < contents.size(); i++) streams.push(lk(contents.get(i)));
    } else if (contents) streams.push(contents);
    for (const st of streams) {
      const data = getStreamData(st);
      for (const [k, v] of scanOps(data)) (report[pi + 1] ??= new Set()).add(`페이지스트림 ${k} ×${v.count} (예: ${v.sample.slice(0, 40)})`);
    }
    // 리소스 (상속 포함)
    let res = lk(node.get(Nm('Resources')));
    if (!res) {
      let p = node.get(Nm('Parent'));
      while (p) { const pn = lk(p); if (!pn) break; const r = pn.get(Nm('Resources')); if (r) { res = lk(r); break; } p = pn.get(Nm('Parent')); }
    }
    inspectResources(res, pi, '', 0);
  }

  const keys = Object.keys(report);
  console.log(`\n칼라 잔류 의심 페이지: ${keys.length}개`);
  for (const k of keys.slice(0, 40)) {
    console.log(`\n■ ${k}페이지:`);
    for (const msg of [...report[k]].slice(0, 8)) console.log('  -', msg);
  }
  if (keys.length > 40) console.log(`\n...외 ${keys.length - 40}페이지`);
})().catch(e => { console.error('분석 오류:', e); process.exit(1); });
