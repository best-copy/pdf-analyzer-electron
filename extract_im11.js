// p2의 Im10, Im11 이미지를 추출해서 분석
const PDFLib = require('./src/libs/pdf-lib.min.js');
const pako   = require('./src/libs/pako.min.js');
const fs     = require('fs');
const Nm     = n => PDFLib.PDFName.of(n);

function getJpegComponentCount(data) {
  if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
  if (data.length < 4 || data[0] !== 0xFF || data[1] !== 0xD8) return -1;
  let i = 2;
  while (i + 3 < data.length) {
    if (data[i] !== 0xFF) { i++; continue; }
    const marker = data[i + 1];
    if (marker === 0xDA || marker === 0xD9) break;
    const segLen = (data[i+2] << 8) | data[i+3];
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      const nf = (i + 9 < data.length) ? data[i + 9] : -1;
      console.log(`  SOF 마커: 0xFF 0x${marker.toString(16).toUpperCase()} at i=${i}`);
      console.log(`  precision=${data[i+4]}, height=${(data[i+5]<<8)|data[i+6]}, width=${(data[i+7]<<8)|data[i+8]}, Nf=${nf}`);
      return nf;
    }
    i += 2 + segLen;
  }
  return -1;
}

(async () => {
  const pdfDoc = await PDFLib.PDFDocument.load(
    fs.readFileSync('D:/바탕화면/test_원본.pdf'),
    { ignoreEncryption: true, throwOnInvalidObject: false });
  const ctx = pdfDoc.context;
  const lk  = v => (v == null ? v : (ctx.lookup(v) ?? v));

  const page  = pdfDoc.getPage(1);
  const node  = page.node;
  const res   = lk(node.get(Nm('Resources')));
  const xDict = lk(res.get(Nm('XObject')));

  const targets = ['Im10', 'Im11'];
  for (const t of targets) {
    const ref = xDict.get(Nm(t));
    if (!ref) { console.log(`${t}: 없음`); continue; }
    const xobj = lk(ref);
    if (!xobj || !xobj.dict) { console.log(`${t}: XObject 없음`); continue; }

    const w = xobj.dict.get(Nm('Width'))?.numberValue ?? 0;
    const h = xobj.dict.get(Nm('Height'))?.numberValue ?? 0;
    const filterVal = xobj.dict.get(Nm('Filter'));
    const filterName = filterVal?.encodedName || 'none';
    const size = xobj.contents?.length ?? 0;

    console.log(`\n=== ${t} (${w}x${h}, ${filterName}, ${size} bytes) ===`);

    if (filterName === '/DCTDecode' || filterName === '/DCT') {
      const data = xobj.contents;
      console.log(`  JPEG 헤더: ${Array.from(data.slice(0,8)).map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);
      const comps = getJpegComponentCount(data);
      console.log(`  → JPEG 컴포넌트 수: ${comps}`);
      // JPEG 파일로 저장
      fs.writeFileSync(`D:/바탕화면/${t}.jpg`, data);
      console.log(`  저장: D:/바탕화면/${t}.jpg`);
    } else if (filterName === '/FlateDecode' || filterName === '/Fl') {
      const bpcVal = xobj.dict.get(Nm('BitsPerComponent'));
      const bpc = bpcVal?.numberValue ?? 8;
      // ColorSpace
      let csRaw = xobj.dict.get(Nm('ColorSpace'));
      if (csRaw && csRaw.objectNumber != null) csRaw = lk(csRaw);
      let csStr = csRaw?.encodedName || '[array]';
      console.log(`  BPC=${bpc} CS=${csStr} contents=${size}`);
      // inflate 시도
      try {
        const inflated = pako.inflate(xobj.contents);
        console.log(`  inflate 성공: ${inflated.length} bytes (예상: ${w*h} bytes)`);
      } catch(e) {
        console.log(`  inflate 실패: ${e.message}`);
      }
    }
  }
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
