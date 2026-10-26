// ⚫ 혼합 검정 → K100 — 판정·점검·바꾸기 (실제 모듈 src/libs/rich-black.js · gs 필요)
//   실행: node scripts/test/rich-black.test.js
// 확인: 판정 기준(혼합 검정·RGB 검정 / K만·남색·빨강·짙은 회색 제외) · 점검 집계(면·선·글자, 함께 쓰는 폼은 쪽마다) ·
//       바꾸기 후 gs 판 분리(tiffsep)로 검정 자리 C·M·Y = 0, 빨강·남색·파랑은 그대로 ·
//       RGB 색공간 검정을 바꾼 뒤 이어지는 sc(파랑)가 깨지지 않음 · 인라인 그림 바이트 보존 · 바꿀 것 없으면 그대로
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { execFileSync } = require('child_process');
const PDFLib = require('pdf-lib');
const ROOT = path.join(__dirname, '..', '..');

const sandbox = { PDFLib, self: undefined, Uint8Array, String, Math, Set, Object };   // 같은 realm의 Uint8Array — pdf-lib이 instanceof로 확인한다
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/libs/rich-black.js'), 'utf8'), sandbox);
const { richBlackIsCmyk, richBlackIsRgb, richBlackScanDoc, richBlackFixDoc, richBlackIdDoc, richBlackIdColor, rgbRichBlackDoc } = sandbox;

function findGs() {
  for (const d of ['D:/Ghostscript', 'C:/Program Files/gs']) {
    try { for (const v of fs.readdirSync(d).sort().reverse()) { const p = path.join(d, v, 'bin', 'gswin64c.exe'); if (fs.existsSync(p)) return p; } } catch (e) {}
  }
  return 'gswin64c';
}
const GS = findGs();
const out = [];
const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);

// tiffsep 판 하나(8비트 그레이, 0=잉크 가득)의 사각 영역 평균 잉크(0~1)
function plateInk(file, page, plate, x0, y0, x1, y1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbsep_'));
  try {
    execFileSync(GS, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=tiffsep', '-sCompression=none', '-r36', `-dFirstPage=${page}`, `-dLastPage=${page}`, '-o', path.join(dir, 'p.tif'), file]);
    const f = fs.readdirSync(dir).find(n => n.includes(`(${plate})`));
    const b = fs.readFileSync(path.join(dir, f));
    // 압축 없는 TIFF — 스트립 오프셋(273)·폭(256)만 읽는다
    const le = b[0] === 0x49;
    const r16 = o => le ? b.readUInt16LE(o) : b.readUInt16BE(o), r32 = o => le ? b.readUInt32LE(o) : b.readUInt32BE(o);
    const ifd = r32(4), cnt = r16(ifd);
    let W = 0, H = 0, off = 0;
    for (let k = 0; k < cnt; k++) {
      const e = ifd + 2 + k * 12, tag = r16(e), typ = r16(e + 2), val = typ === 3 ? r16(e + 8) : r32(e + 8);
      if (tag === 256) W = val; else if (tag === 257) H = val; else if (tag === 273) off = r32(e + 4) === 1 ? val : r32(val);
    }
    let sum = 0, nPix = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += 255 - b[off + y * W + x]; nPix++; }
    return sum / nPix / 255;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

(async () => {
  // ── 1. 판정 기준 ──
  ck('C75 M68 Y67 K90(RGB→CMYK 검정) = 혼합 검정', richBlackIsCmyk(0.75, 0.68, 0.67, 0.90));
  ck('C93 M88 Y89 K80(Japan Color 검정) = 혼합 검정', richBlackIsCmyk(0.93, 0.88, 0.89, 0.80));
  ck('C60 M40 Y40 K100 = 혼합 검정', richBlackIsCmyk(0.6, 0.4, 0.4, 1));
  ck('C100 K100 = 혼합 검정', richBlackIsCmyk(1, 0, 0, 1));
  ck('K100만 = 아님(이미 먹 1도)', !richBlackIsCmyk(0, 0, 0, 1));
  ck('남색 C100 M80 Y0 K60 = 아님', !richBlackIsCmyk(1, 0.8, 0, 0.6));
  ck('짙은 회색 C30 M30 Y30 K60 = 아님', !richBlackIsCmyk(0.3, 0.3, 0.3, 0.6));
  ck('빨강 M100 Y100 = 아님', !richBlackIsCmyk(0, 1, 1, 0));
  ck('RGB 0,0,0 = 검정', richBlackIsRgb(0, 0, 0));
  ck('RGB 20,20,25 = 검정', richBlackIsRgb(20 / 255, 20 / 255, 25 / 255));
  ck('RGB 60,60,60 = 아님', !richBlackIsRgb(60 / 255, 60 / 255, 60 / 255));

  // ── 2. 합성 PDF ──
  const d = await PDFLib.PDFDocument.create(); const ctx = d.context;
  const font = await d.embedFont(PDFLib.StandardFonts.Helvetica);
  const fname = 'F1';
  const fontRef = font.ref;
  const mk = (content, extraRes) => {
    const p = d.addPage([400, 400]);
    p.node.set(PDFLib.PDFName.of('Resources'), ctx.obj(Object.assign({ Font: { [fname]: fontRef } }, extraRes || {})));
    p.node.set(PDFLib.PDFName.of('Contents'), ctx.register(ctx.flateStream(content)));
    return p;
  };
  // 1쪽: 혼합 검정 면(왼쪽 위) · 혼합 검정 선 · 혼합 검정 글자 · 빨강 면(오른쪽 위) · K100 면(왼쪽 아래) · 남색 면(오른쪽 아래) · RGB 검정 면(가운데)
  mk([
    'q 0.75 0.68 0.67 0.9 k 20 220 160 160 re f Q',
    'q 0.75 0.68 0.67 0.9 K 4 w 20 200 m 380 200 l S Q',
    'BT /F1 18 Tf 0.6 0.4 0.4 1 k 30 190 Td (Rich black text) Tj ET',
    'q 0 1 1 0 k 220 220 160 160 re f Q',
    'q 0 0 0 1 k 20 20 160 160 re f Q',
    'q 1 0.8 0 0.6 k 220 20 160 160 re f Q',
    'q 0 0 0 rg 150 150 100 30 re f Q',
  ].join('\n'));
  // 2쪽: RGB 색공간 — 검정 면(왼쪽) 뒤에 같은 색공간으로 파랑 면(오른쪽) · 인라인 그림(바이너리에 'k' 바이트 포함)
  mk([
    '/DeviceRGB cs 0 0 0 sc 20 20 160 360 re f',
    '0 0 1 sc 220 20 160 360 re f',
    'q 20 0 0 20 300 300 cm BI /W 2 /H 1 /CS /RGB /BPC 8 ID \x00\x00\x00k k\xff EI Q',
  ].join('\n'));
  // 3·4쪽: 함께 쓰는 폼(혼합 검정 면)
  const form = ctx.register(ctx.flateStream('0.7 0.6 0.6 0.95 k 0 0 100 100 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100] }));
  mk('q 1 0 0 1 50 50 cm /Fm0 Do Q', { XObject: { Fm0: form } });
  mk('q 1 0 0 1 150 150 cm /Fm0 Do Q', { XObject: { Fm0: form } });
  // 5쪽: 바꿀 것 없음
  mk('q 0 0 0 1 k 20 20 100 100 re f 0 1 1 0 k 120 120 100 100 re f Q');
  const srcBytes = await d.save();
  const tmpIn = path.join(os.tmpdir(), 'rb_in_' + process.pid + '.pdf');
  const tmpOut = path.join(os.tmpdir(), 'rb_out_' + process.pid + '.pdf');
  fs.writeFileSync(tmpIn, srcBytes);

  // ── 3. 점검 ──
  const scanDoc = await PDFLib.PDFDocument.load(srcBytes);
  const sc = richBlackScanDoc(scanDoc, { rgb: true });
  const p1 = sc.pages.find(p => p.page === 1) || {};
  ck('점검 1쪽: 면 2(혼합+RGB)·선 1·글자 1', p1.fill === 2 && p1.stroke === 1 && p1.text === 1, p1);
  ck('점검 1쪽 색값 목록', (p1.colors || []).includes('C75 M68 Y67 K90') && (p1.colors || []).some(c => c.startsWith('RGB 0,0,0')), p1.colors);
  ck('점검 2쪽: RGB 검정 면 1(파랑은 아님)', (sc.pages.find(p => p.page === 2) || {}).fill === 1, sc.pages.find(p => p.page === 2));
  ck('점검: 함께 쓰는 폼은 3쪽·4쪽 모두에 보임', [3, 4].every(n => (sc.pages.find(p => p.page === n) || {}).fill === 1), sc.pages);
  ck('점검: 5쪽(K100·빨강뿐)은 목록에 없음', !sc.pages.some(p => p.page === 5));
  const scNoRgb = richBlackScanDoc(await PDFLib.PDFDocument.load(srcBytes), { rgb: false });
  ck('RGB 검정 빼기 → 2쪽 없음, 1쪽 면 1', !scNoRgb.pages.some(p => p.page === 2) && (scNoRgb.pages.find(p => p.page === 1) || {}).fill === 1, scNoRgb.pages);

  // ── 4. 바꾸기 ──
  const fixDoc = await PDFLib.PDFDocument.load(srcBytes);
  const fx = richBlackFixDoc(fixDoc, { rgb: true });
  ck('바꾸기: 개체 6곳(1쪽 4·2쪽 1·폼 1)', fx.total.edits === 6, fx.total);
  fs.writeFileSync(tmpOut, await fixDoc.save());
  const re = richBlackScanDoc(await PDFLib.PDFDocument.load(fs.readFileSync(tmpOut)), { rgb: true });
  ck('바꾼 뒤 다시 점검하면 혼합 검정 0', re.pages.length === 0, re.pages);

  // 판 분리 — 36dpi, 400pt 쪽 = 200px. 좌표는 위가 0
  const px = v => Math.round(v / 2);   // pt → px(36dpi)
  const box = (x0, y0, x1, y1) => [px(x0) + 3, px(400 - y1) + 3, px(x1) - 3, px(400 - y0) - 3];
  const plates = (file, page, b) => ['Cyan', 'Magenta', 'Yellow', 'Black'].map(pl => Math.round(plateInk(file, page, pl, ...b) * 100));
  const rbBefore = plates(tmpIn, 1, box(20, 220, 180, 380)), rbAfter = plates(tmpOut, 1, box(20, 220, 180, 380));
  ck('1쪽 혼합 검정 면: 전에는 C·M·Y가 있었다', rbBefore[0] > 50 && rbBefore[1] > 50, rbBefore);
  ck('1쪽 혼합 검정 면 → C0 M0 Y0 K100', rbAfter[0] === 0 && rbAfter[1] === 0 && rbAfter[2] === 0 && rbAfter[3] >= 98, rbAfter);
  const rgbAfter = plates(tmpOut, 1, box(150, 150, 250, 180));
  ck('1쪽 RGB 검정 면 → K100만', rgbAfter[0] === 0 && rgbAfter[1] === 0 && rgbAfter[2] === 0 && rgbAfter[3] >= 98, rgbAfter);
  ck('1쪽 빨강 면 그대로(M100 Y100)', JSON.stringify(plates(tmpOut, 1, box(220, 220, 380, 380))) === JSON.stringify(plates(tmpIn, 1, box(220, 220, 380, 380))), plates(tmpOut, 1, box(220, 220, 380, 380)));
  ck('1쪽 남색 면 그대로', JSON.stringify(plates(tmpOut, 1, box(260, 20, 380, 140))) === JSON.stringify(plates(tmpIn, 1, box(260, 20, 380, 140))), plates(tmpOut, 1, box(260, 20, 380, 140)));
  const p2L = plates(tmpOut, 2, box(20, 20, 180, 280)), p2R = plates(tmpOut, 2, box(220, 20, 380, 280)), p2Rb = plates(tmpIn, 2, box(220, 20, 380, 280));
  ck('2쪽 RGB 색공간 검정 → K100', p2L[0] === 0 && p2L[1] === 0 && p2L[2] === 0 && p2L[3] >= 98, p2L);
  ck('2쪽 이어지는 파랑(sc)은 원래 색 그대로 — 색공간 되살림', JSON.stringify(p2R) === JSON.stringify(p2Rb) && p2R[0] > 50, [p2Rb, p2R]);
  const f3 = plates(tmpOut, 3, box(50, 50, 150, 150)), f4 = plates(tmpOut, 4, box(150, 150, 250, 250));
  ck('3·4쪽 함께 쓰는 폼 → 둘 다 K100', [f3, f4].every(v => v[0] === 0 && v[1] === 0 && v[2] === 0 && v[3] >= 98), [f3, f4]);
  // 폰트 안전화(gs pdfwrite)를 거쳐도 K100 그대로 — 앱은 K100 다음에 gs를 돌린다
  const tmpGs = tmpOut.replace('.pdf', '_gs.pdf');
  execFileSync(GS, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite', '-dEmbedAllFonts=true', '-dAutoRotatePages=/None', '-o', tmpGs, tmpOut]);
  const viaGs = plates(tmpGs, 1, box(20, 220, 180, 380));
  ck('gs pdfwrite(폰트 안전화) 뒤에도 C0 M0 Y0 K100', viaGs[0] === 0 && viaGs[1] === 0 && viaGs[2] === 0 && viaGs[3] >= 98, viaGs);
  fs.unlinkSync(tmpGs);
  // 인라인 그림 바이트 보존
  const p2c = (() => { const o = fixDoc; const pg = o.getPages()[1]; const c = o.context.lookup(pg.node.get(PDFLib.PDFName.of('Contents'))); return Buffer.from(PDFLib.decodePDFRawStream(c).decode()).toString('latin1'); })();
  ck('인라인 그림 바이너리 그대로', p2c.includes('ID \x00\x00\x00k k\xff EI'), p2c.slice(p2c.indexOf('BI'), p2c.indexOf('BI') + 60));
  ck('2쪽 고친 스트림 모양(경로 앞 q 0 0 0 1 k … Q · 파랑은 그대로)', /q 0 0 0 1 k 20 20 160 360 re f Q/.test(p2c) && /0 0 1 sc 220 20 160 360 re f/.test(p2c), p2c.slice(0, 160));
  // 5쪽(바꿀 것 없음)은 내용 스트림을 그대로 둔다
  const c5a = scanDoc.getPages()[4].node.get(PDFLib.PDFName.of('Contents')).toString(), c5b = fixDoc.getPages()[4].node.get(PDFLib.PDFName.of('Contents')).toString();
  ck('5쪽은 손대지 않음(같은 스트림)', c5a === c5b, [c5a, c5b]);

  // ── 5. 개체별 선택 ──
  {
    const d2 = await PDFLib.PDFDocument.create(); const c2 = d2.context;
    const fnt = await d2.embedFont(PDFLib.StandardFonts.Helvetica);
    const p = d2.addPage([400, 400]);
    p.node.set(PDFLib.PDFName.of('Resources'), c2.obj({ Font: { F1: fnt.ref } }));
    // 한 번의 색 지정으로 면 두 개(왼쪽·오른쪽) · 클립 경로로 칠한 면(아래 왼쪽) · 같은 BT 안 글자 두 덩어리
    p.node.set(PDFLib.PDFName.of('Contents'), c2.register(c2.flateStream([
      '0.75 0.68 0.67 0.9 k 20 220 160 160 re f 220 220 160 160 re f',
      'q 20 20 160 160 re W f Q',
      'BT /F1 30 Tf 0.75 0.68 0.67 0.9 k 220 120 Td (AAAA) Tj 0 -60 Td (BBBB) Tj ET',
    ].join('\n'))));
    const b2 = await d2.save();
    const sc2 = richBlackScanDoc(await PDFLib.PDFDocument.load(b2), {});
    const keys = sc2.pages[0].items.map(it => it.key + ':' + it.kind);
    ck('개체 5개(면 3·글자 2), 이름표 p0:c0~c4', JSON.stringify(keys) === JSON.stringify(['p0:c0:fill', 'p0:c1:fill', 'p0:c2:fill', 'p0:c3:text', 'p0:c4:text']), keys);
    // 왼쪽 면·클립 면·첫 글자만 바꾸기
    const keep = new Set(['p0:c0', 'p0:c2', 'p0:c3']);
    const d3 = await PDFLib.PDFDocument.load(b2);
    const fx2 = richBlackFixDoc(d3, { isSelected: k => keep.has(k) });
    ck('고른 3곳만 바꿈', fx2.total.edits === 3 && fx2.total.editPages === 1, fx2.total);
    const t2 = path.join(os.tmpdir(), 'rb_sel_' + process.pid + '.pdf');
    fs.writeFileSync(t2, await d3.save());
    const L = plates(t2, 1, box(20, 220, 180, 380)), R = plates(t2, 1, box(220, 220, 380, 380)), CL = plates(t2, 1, box(20, 20, 180, 180));
    ck('같은 색 지정의 왼쪽 면만 K100', L[0] === 0 && L[3] >= 98, L);
    ck('고르지 않은 오른쪽 면은 혼합 검정 그대로', R[0] > 50 && R[1] > 50, R);
    ck('클립 경로 면도 K100(클립 유지)', CL[0] === 0 && CL[3] >= 98, CL);
    const re2 = richBlackScanDoc(await PDFLib.PDFDocument.load(fs.readFileSync(t2)), {});
    const left = re2.pages[0] ? re2.pages[0].items.map(it => it.kind) : [];
    ck('남은 혼합 검정 = 오른쪽 면·둘째 글자', JSON.stringify(left) === JSON.stringify(['fill', 'text']), left);
    const pc = Buffer.from(PDFLib.decodePDFRawStream(d3.context.lookup(d3.getPages()[0].node.get(PDFLib.PDFName.of('Contents')))).decode()).toString('latin1');
    ck('글자: BT 안에서 q 없이 넣고 원래 색으로 되돌림', /0 0 0 1 k \(AAAA\) Tj 0\.75 0\.68 0\.67 0\.9 k/.test(pc) && !/q 0 0 0 1 k \(/.test(pc), pc.slice(pc.indexOf('BT'), pc.indexOf('BT') + 140));
    ck('클립 경로: q 없이 넣고 칠한 뒤 원래 색', /0 0 0 1 k 20 20 160 160 re W f 0\.75 0\.68 0\.67 0\.9 k/.test(pc), pc.slice(pc.indexOf('20 20 160'), pc.indexOf('20 20 160') + 80));
    // 미리보기용 개체 색
    const d4 = await PDFLib.PDFDocument.load(b2);
    const idr = richBlackIdDoc(d4, {});
    ck('미리보기: 개체마다 id(5개)', idr.ids.length === 5 && idr.ids[0] === 'p0:c0', idr.ids);
    const t4 = path.join(os.tmpdir(), 'rb_id_' + process.pid + '.pdf');
    fs.writeFileSync(t4, await d4.save());
    execFileSync(GS, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=ppmraw', '-r36', '-dUseFastColor', '-o', t4 + '.ppm', t4]);
    const pp = fs.readFileSync(t4 + '.ppm'); let o = 0, nl = 0;   // 머리글 3줄 — gs가 넣는 '#' 주석 줄은 세지 않는다(함정 7)
    while (nl < 3) { const lineStart = o; while (pp[o] !== 10) o++; o++; if (pp[lineStart] !== 0x23) nl++; }
    const at = (xpt, ypt) => { const x = Math.round(xpt / 2), y = Math.round((400 - ypt) / 2); const k = o + (y * 200 + x) * 3; return [pp[k], pp[k + 1], pp[k + 2]]; };
    const exp = id => richBlackIdColor(id);
    const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
    ck('미리보기 그림: 왼쪽 면 = id 1 색, 오른쪽 면 = id 2 색', near(at(100, 300), exp(1)) && near(at(300, 300), exp(2)), [at(100, 300), exp(1), at(300, 300), exp(2)]);
    [t2, t4, t4 + '.ppm'].forEach(x => { try { fs.unlinkSync(x); } catch (e) {} });
  }
  // ── 6. RGB검정 리치블랙처리 — RGB 검정만: 면 → C40 M30 Y30 K100 · 글자·선 → K100 · CMYK 혼합 검정·파랑은 그대로 ──
  {
    const rd = await PDFLib.PDFDocument.load(srcBytes);
    const rr = rgbRichBlackDoc(rd, { pages: [0, 1] });
    const t6 = path.join(os.tmpdir(), 'rb_rgbrich_' + process.pid + '.pdf');
    fs.writeFileSync(t6, await rd.save());
    ck('리치블랙처리: RGB 검정 2곳(1쪽 면·2쪽 sc 면)만 · 혼합 검정 CMYK는 안 건드림', rr.total.edits === 2 && rr.total.richFills === 2, rr.total);
    const mid = plates(t6, 1, box(150, 150, 250, 180)), cm = plates(t6, 1, box(20, 220, 180, 380));
    ck('1쪽 RGB 검정 면 → C40 M30 Y30 K100', Math.abs(mid[0] - 40) <= 2 && Math.abs(mid[1] - 30) <= 2 && Math.abs(mid[2] - 30) <= 2 && mid[3] >= 98, mid);
    ck('1쪽 CMYK 혼합 검정 면은 그대로', JSON.stringify(cm) === JSON.stringify(rbBefore), cm);
    const L = plates(t6, 2, box(20, 20, 180, 280)), Rr = plates(t6, 2, box(220, 20, 380, 280));
    ck('2쪽 RGB 색공간 검정 면 → 리치블랙 · 이어지는 파랑은 그대로', Math.abs(L[0] - 40) <= 2 && L[3] >= 98 && JSON.stringify(Rr) === JSON.stringify(plates(tmpIn, 2, box(220, 20, 380, 280))), [L, Rr]);
    // 글자·선은 K100
    const d6 = await PDFLib.PDFDocument.create(); const c6 = d6.context; const f6 = await d6.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const p6 = d6.addPage([400, 400]);
    p6.node.set(PDFLib.PDFName.of('Resources'), c6.obj({ Font: { F1: f6.ref } }));
    p6.node.set(PDFLib.PDFName.of('Contents'), c6.register(c6.flateStream('BT /F1 120 Tf 0 0 0 rg 20 240 Td (HH) Tj ET q 0 0 0 RG 20 w 20 100 m 380 100 l S Q')));
    const d6b = await PDFLib.PDFDocument.load(await d6.save());
    const r6 = rgbRichBlackDoc(d6b, {});
    const t7 = path.join(os.tmpdir(), 'rb_rgbrich2_' + process.pid + '.pdf');
    fs.writeFileSync(t7, await d6b.save());
    const tx = plates(t7, 1, box(30, 250, 70, 320)), ln = plates(t7, 1, box(40, 92, 360, 108));
    ck('RGB 검정 글자·선 → K100(C·M·Y 없음)', r6.total.edits === 2 && r6.total.richFills === 0 && tx[0] === 0 && tx[1] === 0 && tx[3] > 50 && ln[0] === 0 && ln[3] > 50, { t: r6.total, tx, ln });
    [t6, t7].forEach(x => { try { fs.unlinkSync(x); } catch (e) {} });
  }
  fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut);
  let fail = 0;
  out.forEach(([m, n, x]) => { if (m !== '✔') fail++; console.log(m, n, m === '✔' ? '' : x); });
  console.log(`결과: ${out.length - fail} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
