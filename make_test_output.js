// 새 이미지 변환 코드를 이전 변환본(이미지 미변환 상태)에 적용해 출력 생성
const PDFLib = require('./src/libs/pdf-lib.min.js');
const pako = require('./src/libs/pako.min.js');
const fs = require('fs');
const Nm = (n) => PDFLib.PDFName.of(n);

function extractFn(html, marker) {
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) {
    const c = html[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error('unbalanced: ' + marker);
}

(async () => {
  const html = fs.readFileSync('src/index.html', 'utf8');
  const code = [
    extractFn(html, 'function removePNGPredictor'),
    extractFn(html, 'function applyPNGPredictorGray'),
    extractFn(html, 'function inflateLenient'),
    extractFn(html, 'function imgFilterNameOf'),
    extractFn(html, 'function imgPredictorOf'),
    extractFn(html, 'function buildPdfFnEvaluator'),
    extractFn(html, 'function imgResolveCSKind'),
    extractFn(html, 'function imgGrayOfBytes'),
    extractFn(html, 'function convertIndexedImagePalette'),
    extractFn(html, 'function buildTintGrayLUT'),
    'const getDotGain = () => 0;',
    'const grayWorkerPool = { run: async (op) => { throw new Error("WORKER:" + op); } };',
    extractFn(html, 'async function convertJpegXObjectToGrayscale'),
    extractFn(html, 'async function convertJpxXObjectToGrayscale'),
    extractFn(html, 'async function convertSeparationImage'),
    extractFn(html, 'async function convertFlateXObjectToGrayscale'),
    extractFn(html, 'async function convertXObjectImageToGrayscale'),
    'return { convertXObjectImageToGrayscale };',
  ].join('\n');
  const api = new Function('PDFLib', 'pako', 'console', 'document', code)(PDFLib, pako, console, undefined);

  const pdfDoc = await PDFLib.PDFDocument.load(
    fs.readFileSync('D:/바탕화면/test_원본.pdf'),
    { ignoreEncryption: true, throwOnInvalidObject: false });
  const ctx = pdfDoc.context;
  const lk = (v) => (v == null ? v : (ctx.lookup(v) !== undefined ? ctx.lookup(v) : v));

  let n = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!obj || !obj.dict || !obj.contents) continue;
    const sub = obj.dict.get(Nm('Subtype'));
    if (!sub || sub.encodedName !== '/Image') continue;
    const cs = lk(obj.dict.get(Nm('ColorSpace')));
    if (!cs || cs.encodedName === '/DeviceGray' || cs.encodedName === '/CalGray') continue;
    try { await api.convertXObjectImageToGrayscale(pdfDoc, obj, null); n++; } catch (e) {}
  }
  console.log('변환 시도:', n);
  const out = await pdfDoc.save({ useObjectStreams: false });
  fs.writeFileSync('D:/바탕화면/test_newcode_output.pdf', out);
  console.log('저장: D:/바탕화면/test_newcode_output.pdf', Math.round(out.length / 1024), 'KB');
})().catch(e => { console.error('ERR:', e); process.exit(1); });
