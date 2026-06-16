// p2 이미지 XObject 목록 + 변환 후 무결성 검사
const PDFLib = require('./src/libs/pdf-lib.min.js');
const pako   = require('./src/libs/pako.min.js');
const fs     = require('fs');
const Nm     = n => PDFLib.PDFName.of(n);

function getJpegComponentCount(arr) {
  let i = 0;
  while (i < arr.length - 3) {
    if (arr[i] !== 0xFF) break;
    const marker = arr[i + 1];
    if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2 ||
        marker === 0xC3 || marker === 0xC9 || marker === 0xCA || marker === 0xCB) {
      return arr[i + 7];  // SOF: Nf (number of components)
    }
    if (marker === 0xD8 || marker === 0xD9) { i += 2; continue; }
    if (arr.length <= i + 3) break;
    const len = (arr[i + 2] << 8) | arr[i + 3];
    i += 2 + len;
  }
  return 3;
}

(async () => {
  const pdfBytes = fs.readFileSync('D:/바탕화면/test_원본.pdf');
  const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes,
    { ignoreEncryption: true, throwOnInvalidObject: false });
  const ctx = pdfDoc.context;
  const lk  = v => (v == null ? v : (ctx.lookup(v) ?? v));

  const page  = pdfDoc.getPage(1); // p2 (0-index)
  const node  = page.node;
  const res   = lk(node.get(Nm('Resources')));
  if (!res) { console.log('no resDict'); return; }

  const xDict = lk(res.get(Nm('XObject')));
  if (!xDict || typeof xDict.entries !== 'function') { console.log('no XObject'); return; }

  const rows = [];
  for (const [nameObj, ref] of xDict.entries()) {
    const xobj = lk(ref);
    if (!xobj || !xobj.dict) continue;
    const sub = xobj.dict.get(Nm('Subtype'));
    if (!sub || sub.encodedName !== '/Image') continue;

    const nameStr = typeof nameObj === 'string' ? nameObj : (nameObj.encodedName || String(nameObj));
    const w = +((xobj.dict.get(Nm('Width'))?.numberValue) ?? 0);
    const h = +((xobj.dict.get(Nm('Height'))?.numberValue) ?? 0);

    // ColorSpace 해석
    let csRaw = xobj.dict.get(Nm('ColorSpace'));
    if (csRaw && csRaw.objectNumber != null) csRaw = lk(csRaw);
    let csStr = '';
    if (!csRaw) csStr = 'null';
    else if (csRaw.encodedName) csStr = csRaw.encodedName;
    else if (typeof csRaw.size === 'function') {
      const first = lk(csRaw.get(0));
      const fn = first?.encodedName || '?';
      if (fn === '/ICCBased' && csRaw.size() > 1) {
        const st = lk(csRaw.get(1));
        const N = st?.dict?.get?.(Nm('N'))?.numberValue ?? '?';
        csStr = `[/ICCBased N=${N}]`;
      } else if (fn === '/Indexed') {
        const base = lk(csRaw.get(1));
        csStr = `[/Indexed ${base?.encodedName || '?'}]`;
      } else if (fn === '/Separation') {
        const nm = lk(csRaw.get(1));
        csStr = `[/Separation ${nm?.encodedName || '?'}]`;
      } else csStr = `[${fn}...]`;
    }

    // Filter
    let filterRaw = xobj.dict.get(Nm('Filter'));
    let filterStr = '';
    if (!filterRaw) filterStr = 'none';
    else if (filterRaw.encodedName) filterStr = filterRaw.encodedName;
    else if (typeof filterRaw.size === 'function') {
      const parts = [];
      for (let i = 0; i < filterRaw.size(); i++) parts.push(lk(filterRaw.get(i))?.encodedName || '?');
      filterStr = '[' + parts.join(',') + ']';
    }

    // ImageMask
    const im = xobj.dict.get(Nm('ImageMask'));
    const isMask = im && (im === PDFLib.PDFBool.True || im.asBoolean?.() === true);

    // JPEG 컴포넌트 수
    let jpegComps = '';
    if (filterStr === '/DCTDecode' && xobj.contents) {
      jpegComps = ` jpegComps=${getJpegComponentCount(xobj.contents)}`;
    }

    // SMask
    const hasSMask = !!xobj.dict.get(Nm('SMask'));
    // Decode 배열
    const hasDecode = !!xobj.dict.get(Nm('Decode'));

    const size = xobj.contents ? xobj.contents.length : 0;
    rows.push(`${nameStr.padEnd(8)} ${String(w).padStart(5)}x${String(h).padEnd(5)} CS=${csStr.padEnd(25)} F=${filterStr.padEnd(14)} ${isMask?'MASK ':''} ${hasSMask?'SMask ':''}${hasDecode?'Decode ':''}${jpegComps} bytes=${size}`);
  }

  console.log(`=== p2 이미지 XObject (${rows.length}개) ===`);
  rows.forEach(r => console.log(r));
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
