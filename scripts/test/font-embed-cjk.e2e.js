// PDF에 빠진 글꼴을 이 PC 글꼴로 싣기 (app-process embedInstalledCjkFonts · main fonts:resolve) + 불러올 때 적용 + 경고
//   실행: npx electron scripts/test/font-embed-cjk.e2e.js
// 사용자 지적(2026-10-08, 1-1.pdf · 1-1-1-1.pdfw): 아크로뱃 머리글(글꼴 미포함)의 '한·일' 가운데 점이 밀리고 'ー'가 세로 막대,
//   '教'만 굵게. 원인: pdf.js·gs가 다른 글꼴로 대신 그림 — gs는 글자 번호(CID 104 = 전각 '・')로 찾아 좁은 폭(319) 칸에 넓은 점.
//   이제 이 PC의 글꼴을 **문자 코드 기준**으로 싣는다(TTF: Identity-H + CIDToGIDMap / OTF: 코드→CID 표(CMap)) — 불러올 때부터.
// 필요: KoPubWorld돋움(TTF·Pro OTF)·굴림(TTC)·Arial·아크로뱃 KozGoPr6N-Medium.otf — 없으면 해당 항목은 건너뛴다.
// 확인: 합성 PDF(글꼴 미포함 7종) → 실린 방식 · gs/pdf.js 렌더에서 '한 · 일' 세 덩어리(점이 다음 글자와 안 겹침)
//       · 넣지 못한 것(세로쓰기·없는 글꼴)만 경고 목록 · 불러올 때 원본에 실림 · 폰트 완전 임베드 저장본
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

let gsPath = null;
function installHandlers() {   // main.js 원본 그대로(gs·글꼴 색인·fonts:resolve·폰트 안전화)
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').split('\r\n').join('\n');
  const cut = (a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error('main.js에서 못 찾음: ' + a); return src.slice(i, j + b.length); };
  const NL = '\n';
  const code = ['let _gsPath = null;', cut('function findGhostscript() {', NL + '}' + NL),
    cut('let _fontIndex = null;', NL + '// ── IPC: 폰트 아웃라인화'),
    cut("ipcMain.handle('fonts:resolve'", NL + '});' + NL),
    cut("ipcMain.handle('gs:outlineFonts'", NL + '});' + NL),
    cut("ipcMain.handle('gs:probeFonts'", NL + '});' + NL), 'return findGhostscript;'].join(NL);
  return new Function('ipcMain', 'path', 'os', 'fs', 'execFile', 'process', '__dirname', code)(ipcMain, path, os, fs, execFile, process, ROOT);
}
// gs 회색 렌더의 가로 띠에서 글자 덩어리(가로로 이어진 잉크 구간) — 페이지 좌표(pt)
const inkRuns = (file, y0, y1, x1, dpi) => {
  const b = execFileSync(gsPath, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pgmraw', `-r${dpi}`, '-dFirstPage=1', '-dLastPage=1', '-o', '-', file], { maxBuffer: 1 << 28 });
  let i = 0; const f = [];   // PGM 머리 — '#' 주석은 줄 끝까지 건너뛴다(함정 7)
  while (f.length < 4) {
    while (b[i] <= 32) i++;
    if (b[i] === 35) { while (b[i] !== 10) i++; continue; }
    let s = ''; while (b[i] > 32) s += String.fromCharCode(b[i++]);
    f.push(s);
  }
  i++;
  const W = +f[1], H = +f[2], px = b.subarray(i), k = dpi / 72;
  const col = new Array(W).fill(false);
  for (let y = Math.floor((H / k - y1) * k); y < Math.ceil((H / k - y0) * k); y++) for (let x = 0; x < Math.min(W, x1 * k); x++) if (px[y * W + x] < 140) col[x] = true;
  const runs = []; let s = -1;
  for (let x = 0; x <= W; x++) { if (x < W && col[x]) { if (s < 0) s = x; } else if (s >= 0) { runs.push([+(s / k).toFixed(1), +(x / k).toFixed(1)]); s = -1; } }
  return runs;
};
// 줄마다 (글꼴 이름, 인코딩, 자손 종류, 체계, 내용, y) — '한·일' 줄은 점 위치를 본다
const LINES = [
  ['KoPubWorldDotumMedium', 'UniKS-UTF16-H', 'CIDFontType2', 'Korea1', '<D55C00B7C77C>', 560, 'dot'],
  ['KoPubWorldDotumProMedium', 'UniKS-UTF16-H', 'CIDFontType0', 'Korea1', '<D55C00B7C77C>', 500, 'dot'],
  ['Gulim', 'UniKS-UTF16-H', 'CIDFontType2', 'Korea1', '<D55C00B7C77C>', 440, 'dot'],
  ['KozGoPr6N-Medium', 'UniJIS-UTF16-H', 'CIDFontType0', 'Japan1', '<65593000>', 380, ''],
  ['NotoSansKR-Medium', 'UniKS-UTF16-V', 'CIDFontType2', 'Korea1', '<D55C>', 320, ''],
  ['NoSuchFont-Regular', 'UniKS-UTF16-H', 'CIDFontType2', 'Korea1', '<D55C>', 260, ''],
];

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-cjkembed-e2e'));
app.whenReady().then(async () => {
  gsPath = installHandlers()();
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 3 && !/No handler|Security/.test(msg)) console.log('  [앱] ' + msg.slice(0, 200)); });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    try {
    window.confirm = () => true;
    const LINES = ${JSON.stringify(LINES)};
    const { PDFDocument, PDFName, PDFString } = PDFLib; const N = n => PDFName.of(n);
    const found = await window.electronAPI.resolveFonts(LINES.map(l => l[0]).concat(['Arial']));
    const have = n => !!found[n];
    // 합성: 아크로뱃 머리글과 같은 꼴 — Type0 + 유니코드 CMap, 글꼴 미포함, 폭은 비례(가운데 점 CID 104 = 319)
    const d = await PDFDocument.create(); const ctx = d.context;
    const fonts = {};
    LINES.forEach(([name, enc, sub, ord], k) => {
      const fd = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: name, Flags: 4, FontBBox: [-100, -200, 1100, 900], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 700, StemV: 80 }));
      const df = ctx.register(ctx.obj({ Type: 'Font', Subtype: sub, BaseFont: name, CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of(ord), Supplement: 1 }, FontDescriptor: fd, DW: 1000, W: ord === 'Korea1' ? [104, [319]] : [] }));
      fonts['F' + k] = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: name, Encoding: enc, DescendantFonts: [df] }));
    });
    // 영문 단순 글꼴(글꼴 미포함 TrueType · WinAnsi)
    const afd = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'Arial', Flags: 32, FontBBox: [-665, -325, 2000, 1040], ItalicAngle: 0, Ascent: 905, Descent: -212, CapHeight: 716, StemV: 80 }));
    fonts.FA = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'Arial', Encoding: 'WinAnsiEncoding', FirstChar: 65, LastChar: 66, Widths: [667, 667], FontDescriptor: afd }));
    const p = d.addPage([400, 620]);
    p.node.set(N('Resources'), ctx.obj({ Font: fonts }));
    p.node.set(N('Contents'), ctx.register(ctx.flateStream(LINES.map((l, k) => 'BT /F' + k + ' 40 Tf 40 ' + l[5] + ' Td ' + l[4] + ' Tj ET').join('\\n') + '\\nBT /FA 30 Tf 40 200 Td (AB) Tj ET')));
    const src = await d.save();
    // ── 싣기 ──
    const r1 = await embedInstalledCjkFonts(src);
    const expectEmb = LINES.filter(l => have(l[0]) && !/-V$/.test(l[1])).map(l => l[0]).concat(have('Arial') ? ['Arial'] : []);
    ck('설치된 글꼴은 모두 실림(가로쓰기)', expectEmb.every(n => r1.embedded.includes(n)), { embedded: r1.embedded, expect: expectEmb });
    const miss = r1.missing.map(m => m.name).sort();
    ck('경고 목록 = 세로쓰기(이 PC에 있어도 못 넣음) + 없는 글꼴', JSON.stringify(miss) === JSON.stringify(['NoSuchFont-Regular'].concat(have('NotoSansKR-Medium') ? ['NotoSansKR-Medium'] : []).sort())
       && r1.missing.every(m => m.why), r1.missing);
    const d1 = await PDFDocument.load(r1.bytes.slice(0)); const L = o => d1.context.lookup(o) || o;
    const fd1 = L(L(d1.getPage(0).node.Resources()).get(N('Font')));
    const info = k => { const t = L(fd1.get(N(k))), c = L(L(t.get(N('DescendantFonts'))).get(0)), ds = L(c.get(N('FontDescriptor')));
      return { enc: String(t.get(N('Encoding'))).slice(0, 14), sub: String(c.get(N('Subtype'))), ff: ['FontFile2', 'FontFile3'].find(x => ds.get(N(x))) || '', map: !!c.get(N('CIDToGIDMap')), tu: !!t.get(N('ToUnicode')) }; };
    if (have('KoPubWorldDotumMedium')) { const i = info('F0'); ck('TTF: Identity-H + CIDToGIDMap + FontFile2 + ToUnicode', i.enc === '/Identity-H' && i.map && i.ff === 'FontFile2' && i.tu, i); }
    if (have('KoPubWorldDotumProMedium')) { const i = info('F1'); ck('OTF: 코드→CID 표(CMap) + FontFile3 + ToUnicode', /^\\d+ 0 R$/.test(i.enc) && i.sub === '/CIDFontType0' && i.ff === 'FontFile3' && i.tu, i); }
    if (have('Gulim')) { const i = info('F2'); ck('TTC(굴림): 한 글꼴만 떼어 FontFile2', i.ff === 'FontFile2' && i.enc === '/Identity-H', i); }
    if (have('Arial')) { const a = L(fd1.get(N('FA'))); ck('영문 단순 글꼴: FontFile2로 실림', !!L(a.get(N('FontDescriptor'))).get(N('FontFile2'))); }
    // pdf.js 렌더(앱 화면과 같은 경로)에서 '한·일' 줄의 덩어리
    const pdf = await openPdfDoc({ data: r1.bytes.slice(0) }).promise; const pg = await pdf.getPage(1);
    const sc = 4, vp = pg.getViewport({ scale: sc }); const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
    const cx = cv.getContext('2d', { willReadFrequently: true }); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
    await renderPageNoSeams(pg, { canvasContext: cx, viewport: vp });
    const runsJs = (y0, y1) => { const H = cv.height, Wd = Math.round(200 * sc), dd = cx.getImageData(0, Math.round(H - y1 * sc), Wd, Math.round((y1 - y0) * sc)).data;
      const col = new Array(Wd).fill(false); for (let i = 0; i < dd.length; i += 4) if (dd[i] < 140) col[(i / 4) % Wd] = true;
      const r = []; let s = -1; for (let x = 0; x <= Wd; x++) { if (x < Wd && col[x]) { if (s < 0) s = x; } else if (s >= 0) { r.push([+(s / sc).toFixed(1), +(x / sc).toFixed(1)]); s = -1; } } return r; };
    const pdfjsRuns = LINES.map(l => l[6] === 'dot' && have(l[0]) ? runsJs(l[5] - 8, l[5] + 40) : null);
    await pdf.destroy();
    // ── 불러올 때 적용 ──
    startLoad([{ name: 'fonts.pdf', size: src.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(src.slice(0).buffer) }]);
    for (let i = 0; i < 300 && !(pageResults.length === 1 && pageResults[0] && pageResults[0].thumbnail && isTabReady(tabs.get(activeTabId))); i++) await new Promise(r => setTimeout(r, 100));
    const od = await PDFDocument.load(originalPdfBytes.slice(0)); const osc = scanDocFonts(od);
    const leftAfterLoad = [...osc.missing.keys()].sort();
    const tab = tabs.get(activeTabId);
    ck('불러올 때 원본에 실림 — 남은 미포함은 경고 대상뿐', JSON.stringify(leftAfterLoad) === JSON.stringify(miss), leftAfterLoad);
    ck('분석 완료 안내에 넣은 글꼴·넣지 못한 글꼴', /🔤 PDF에 빠진 글꼴/.test(fontEmbedNote(tab)) && /넣지 못한 글꼴/.test(fontEmbedNote(tab)));
    // ── 폰트 완전 임베드 저장 + 저장 전 경고 목록 ──
    _outlineMode = 'embed';
    const rep = await missingFontsReport(originalPdfBytes);
    ck('저장 전 경고 = 넣지 못한 것과 같음', JSON.stringify(rep.map(m => m.name).sort()) === JSON.stringify(miss), rep);
    const r2 = await buildOutlinedBytes(originalPdfBytes);
    const a = window.electronAPI.writeTempFile(src, 'pdf'), b = window.electronAPI.writeTempFile(r1.bytes, 'pdf'), c = window.electronAPI.writeTempFile(r2, 'pdf');
    return { out, a, b, c, have: found, pdfjsRuns };
    } catch (e) { out.push(['✘', '예외', String(e && e.stack || e).slice(0, 600)]); return { out }; }
  })()`);

  if (res.b) {
    LINES.forEach((l, k) => {
      if (l[6] !== 'dot' || !res.have[l[0]]) return;
      const y0 = l[5] - 8, y1 = l[5] + 40;
      const before = inkRuns(res.a, y0, y1, 200, 288), after = inkRuns(res.b, y0, y1, 200, 288), saved = inkRuns(res.c, y0, y1, 200, 288), js = res.pdfjsRuns[k];
      const ok = r => r && r.length === 3;
      res.out.push([ok(after) && ok(saved) && ok(js) ? '✔' : '✘', `${l[0]}: gs·저장본·pdf.js 모두 한 · 점 · 일 세 덩어리`, JSON.stringify({ gs: after, saved, pdfjs: js, 싣기전gs: before })]);
    });
    for (const f of [res.a, res.b, res.c]) { try { fs.unlinkSync(f); } catch (e) {} }
  }
  let fail = 0;
  res.out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${String(x).slice(0, 420)}`); });
  console.log(`\n결과: ${res.out.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
