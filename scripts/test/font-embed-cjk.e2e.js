// PDF에 빠진 한중일 글꼴을 이 PC 글꼴로 싣기 (app-process embedInstalledCjkFonts · main fonts:resolve) + 저장 전 경고
//   실행: npx electron scripts/test/font-embed-cjk.e2e.js
// 사용자 지적(2026-10-08, 1-1.pdf): 아크로뱃 머리글(글꼴 미포함)의 '한·일' 가운데 점이 E-book·저장본에서 다음 글자 위로 밀리고
//   'ー'가 세로 막대, '教'가 다른 글꼴. 원인: pdf.js·gs가 다른 글꼴로 대신 그림 — gs는 글자 번호(CID 104 = 전각 '・')로
//   찾아 좁은 폭(319) 칸에 넓은 점을 그렸다. 이제 이 PC의 글꼴을 문자 코드 기준(TrueType) 또는 같은 체계(CID CFF)로 싣는다.
// 필요: KoPubWorld돋움(TTF) 설치 · 아크로뱃의 KozGoPr6N-Medium.otf — 없으면 해당 항목은 건너뛴다.
// 확인: 합성 PDF(글꼴 미포함 Type0 3종: KoPub·고즈카·없는 글꼴) → 싣기 결과 · gs 렌더에서 '한 · 일' 세 덩어리가 겹치지 않음
//       · 폰트 완전 임베드(buildOutlinedBytes) 결과도 같음 · 없는 글꼴만 경고 목록에
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
// gs 회색 렌더(72dpi×k)의 한 줄 띠에서 글자 덩어리(가로로 이어진 잉크 구간) — 페이지 좌표(pt)
const inkRuns = (file, y0, y1, dpi) => {
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
  if (!(W > 0 && H > 0)) throw new Error('gs 렌더 머리를 못 읽음: ' + JSON.stringify(f) + ' ' + b.subarray(0, 80).toString('latin1'));
  const col = new Array(W).fill(false);
  for (let y = Math.floor((H / k - y1) * k); y < Math.ceil((H / k - y0) * k); y++) for (let x = 0; x < W; x++) if (px[y * W + x] < 140) col[x] = true;
  const runs = []; let s = -1;
  for (let x = 0; x <= W; x++) { if (x < W && col[x]) { if (s < 0) s = x; } else if (s >= 0) { runs.push([+(s / k).toFixed(1), +(x / k).toFixed(1)]); s = -1; } }
  return runs;
};

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
    const { PDFDocument, PDFName, PDFString, PDFNumber, PDFHexString } = PDFLib; const N = n => PDFName.of(n);
    const found = await window.electronAPI.resolveFonts(['KoPubWorldDotumMedium', 'KozGoPr6N-Medium', 'NoSuchFont-Regular']);
    const haveKo = !!found.KoPubWorldDotumMedium, haveJa = !!found['KozGoPr6N-Medium'];
    ck('없는 글꼴은 못 찾음', !found['NoSuchFont-Regular']);
    // 합성: 아크로뱃 머리글과 같은 꼴 — Type0 + 유니코드 CMap, 글꼴 미포함, 폭은 비례(가운데 점 CID 104 = 319)
    const d = await PDFDocument.create(); const ctx = d.context;
    const t0 = (name, enc, sub, ord, sup, W) => {
      const fd = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: name, Flags: 4, FontBBox: [-100, -200, 1100, 900], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 700, StemV: 80 }));
      const df = ctx.register(ctx.obj({ Type: 'Font', Subtype: sub, BaseFont: name, CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of(ord), Supplement: sup }, FontDescriptor: fd, DW: 1000, W }));
      return ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: name, Encoding: enc, DescendantFonts: [df] }));
    };
    const fKo = t0('KoPubWorldDotumMedium', 'UniKS-UTF16-H', 'CIDFontType2', 'Korea1', 1, [104, [319]]);
    const fJa = t0('KozGoPr6N-Medium', 'UniJIS-UTF16-H', 'CIDFontType0', 'Japan1', 5, []);
    const fNo = t0('NoSuchFont-Regular', 'UniKS-UTF16-H', 'CIDFontType2', 'Korea1', 1, []);
    const p = d.addPage([400, 200]);
    p.node.set(N('Resources'), ctx.obj({ Font: { F1: fKo, F2: fJa, F3: fNo } }));
    p.node.set(N('Contents'), ctx.register(ctx.flateStream(
      'BT /F1 40 Tf 40 120 Td <D55C00B7C77C> Tj ET\\nBT /F2 40 Tf 240 120 Td <6559> Tj ET\\nBT /F3 20 Tf 40 40 Td <D55C> Tj ET')));
    const src = await d.save();
    const rep = await missingFontsReport(src);
    ck('저장 전 경고 목록 = 이 PC에 없는 글꼴만', rep.length === 1 && rep[0].name === 'NoSuchFont-Regular' && rep[0].pages[0] === 1, rep);
    const r1 = await embedInstalledCjkFonts(src);
    ck('설치된 두 글꼴을 싣고 없는 것은 missing', (!haveKo || r1.embedded.includes('KoPubWorldDotumMedium')) && (!haveJa || r1.embedded.includes('KozGoPr6N-Medium'))
       && r1.missing.length === 1 && r1.missing[0].name === 'NoSuchFont-Regular', { embedded: r1.embedded, missing: r1.missing });
    const d1 = await PDFDocument.load(r1.bytes.slice(0)); const L = o => d1.context.lookup(o) || o;
    const fonts = L(L(d1.getPage(0).node.Resources()).get(N('Font')));
    const ko = L(fonts.get(N('F1'))), kd = L(L(ko.get(N('DescendantFonts'))).get(0));
    if (haveKo) ck('KoPub: Identity-H + CIDToGIDMap + TrueType 실림 + ToUnicode', String(ko.get(N('Encoding'))) === '/Identity-H' && !!kd.get(N('CIDToGIDMap'))
       && !!L(kd.get(N('FontDescriptor'))).get(N('FontFile2')) && !!ko.get(N('ToUnicode')) && String(kd.get(N('Subtype'))) === '/CIDFontType2');
    const ja = L(fonts.get(N('F2'))), jd = L(L(ja.get(N('DescendantFonts'))).get(0));
    if (haveJa) ck('고즈카: 같은 체계(Japan1) → 인코딩 그대로 + OpenType 실림', String(ja.get(N('Encoding'))) === '/UniJIS-UTF16-H'
       && !!L(jd.get(N('FontDescriptor'))).get(N('FontFile3')));
    // 폰트 완전 임베드(저장 경로)
    _outlineMode = 'embed';
    const r2 = await buildOutlinedBytes(src);
    const d2 = await PDFDocument.load(r2.slice(0)); const sc = scanDocFonts(d2);
    ck('폰트 완전 임베드 결과: 없는 글꼴만 미포함으로 남지 않음(gs가 대체해 실음)', !sc.missing.has('KoPubWorldDotumMedium') && !sc.missing.has('KozGoPr6N-Medium'), [...sc.missing.keys()]);
    const a = window.electronAPI.writeTempFile(src, 'pdf'), b = window.electronAPI.writeTempFile(r1.bytes, 'pdf'), c = window.electronAPI.writeTempFile(r2, 'pdf');
    return { out, a, b, c, haveKo };
    } catch (e) { out.push(['✘', '예외', String(e && e.stack || e).slice(0, 600)]); return { out }; }
  })()`);

  if (res.b) {
    // '한·일' 줄(y 110~160pt): 한 · 점 · 일 이 서로 떨어진 세 덩어리여야 한다 — 점이 밀리면 '일'과 붙어 두 덩어리
    const runs = f => inkRuns(f, 112, 160, 288).filter(r => r[0] < 200);
    const before = runs(res.a), after = runs(res.b), saved = runs(res.c);
    if (res.haveKo) {
      res.out.push([after.length === 3 ? '✔' : '✘', '실은 뒤 gs: 한 · 점 · 일 세 덩어리(점이 다음 글자와 겹치지 않음)', JSON.stringify(after)]);
      res.out.push([saved.length === 3 ? '✔' : '✘', '폰트 완전 임베드 저장본 gs: 세 덩어리', JSON.stringify(saved)]);
      console.log('  (참고) 싣기 전 gs 대체 렌더:', JSON.stringify(before));
    } else res.out.push(['✔', 'KoPubWorld돋움이 없어 렌더 검사는 건너뜀', '']);
    for (const f of [res.a, res.b, res.c]) { try { fs.unlinkSync(f); } catch (e) {} }
  }
  let fail = 0;
  res.out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.out.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
