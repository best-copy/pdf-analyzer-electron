// 흑백변환 — JPEG 2000(JPXDecode) 사진 회귀 (app-process convertJpxXObjectToGrayscale · decodeJpxGray)
//   실행: npx electron scripts/test/bw-jpx.e2e.js
// Chromium은 JPX를 못 연다 — 예전 코드는 <img>로 시도하다 늘 실패해 **사진을 컬러로 남겼다**
// (실파일 도록 146쪽: 흑백 체크 131쪽 중 126쪽에 CMY 잉크 → 프린터 컬러 과금). 이제 Ghostscript가 회색으로 풀고
// 워커가 1성분 JPEG(DeviceGray)로 굽는다. 확인: 사진 사전 · 프린터 잉크(gs inkcov C=M=Y=0) · 밝기(원본 gs 회색 렌더와 대조).
//   fixtures/jpx-gradient.jp2 · .j2k = 96×64 색 그라데이션(Pillow로 만든 것, 각 0.5KB 미만)
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

// main.js 핸들러를 원본 그대로 꺼내 등록(analyze-gs-cache.e2e.js와 같은 방식)
let gsPath = null;
function installMainHandlers() {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').split('\r\n').join('\n');
  const cut = (a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error('main.js에서 못 찾음: ' + a); return src.slice(i, j); };
  const code = ['let _gsPath = null;', cut('function findGhostscript() {', '\n// gs inkcov 실행'),
    cut("ipcMain.handle('gs:renderThumbs'", '// ── IPC: 2GB'), 'return findGhostscript;'].join('\n');
  return new Function('ipcMain', 'path', 'os', 'fs', 'spawn', 'app', 'process', '__dirname', code)(ipcMain, path, os, fs, spawn, app, process, ROOT);
}
// gs 회색 렌더(1쪽) 평균 밝기 · 잉크
const pgmMean = (gs, file, page) => {
  const b = execFileSync(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pgmraw', '-r72', `-dFirstPage=${page}`, `-dLastPage=${page}`, '-o', '-', file], { maxBuffer: 64 << 20 });
  let i = 0; const f = [];
  while (f.length < 4) { let s = ''; while (b[i] > 32) s += String.fromCharCode(b[i++]); i++; if (s && s[0] !== '#') f.push(s); }
  const px = b.subarray(i); let s = 0; for (const v of px) s += v; return s / px.length;
};
const inkcov = (gs, file) => execFileSync(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=inkcov', '-r72', '-o', '-', file], { encoding: 'latin1' })
  .split(/\r?\n/).map(l => l.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+CMYK/)).filter(Boolean).map(m => m.slice(1, 5).map(Number));

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-jpx-e2e'));
app.whenReady().then(async () => {
  gsPath = installMainHandlers()();
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 2 && /JPEG 2000|JPX/.test(msg)) console.log('  [앱] ' + msg.slice(0, 200)); });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  const fx = n => [...fs.readFileSync(path.join(__dirname, 'fixtures', n))];

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    try {
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 60000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const { PDFDocument, PDFName } = PDFLib; const N = n => PDFName.of(n);
    // 1쪽: JP2(색공간 없음 — JPX 안의 colr 상자) · 2쪽: 코드스트림 J2K + /DeviceRGB · 3쪽: 회색 글자만
    const d = await PDFDocument.create(); const ctx = d.context;
    const jp2 = Uint8Array.from(${JSON.stringify(fx('jpx-gradient.jp2'))}), j2k = Uint8Array.from(${JSON.stringify(fx('jpx-gradient.j2k'))});
    for (const [data, cs] of [[jp2, null], [j2k, 'DeviceRGB']]) {
      const dict = { Type: 'XObject', Subtype: 'Image', Width: 96, Height: 64, Filter: 'JPXDecode' };
      if (cs) { dict.ColorSpace = cs; dict.BitsPerComponent = 8; }
      const ref = ctx.register(ctx.stream(data, dict));
      const p = d.addPage([300, 220]); p.node.setXObject(N('Im1'), ref);
      p.node.set(N('Contents'), ctx.register(ctx.flateStream('q 240 0 0 160 30 30 cm /Im1 Do Q')));
    }
    { const p = d.addPage([300, 220]); p.node.set(N('Contents'), ctx.register(ctx.flateStream('0.3 g 20 20 100 40 re f'))); }
    const bytes = await d.save();
    const tin = window.electronAPI.writeTempFile(bytes, 'pdf');

    startLoad([{ name: 'jpx.pdf', size: bytes.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(bytes.slice(0).buffer) }]);
    await waitFor(() => pageResults.length === 3 && pageResults.every(r => r && r.thumbnail) && isTabReady(tabs.get(activeTabId)), 120000);
    ck('전제: 1·2쪽 컬러로 판정', pageResults[0].isColor && pageResults[1].isColor && !pageResults[2].isColor, pageResults.map(r => r.isColor));
    processingOptions.bw = true; processingOptions.inkNorm = true;
    selectedPages.clear(); selectedPages.add(1); selectedPages.add(2);
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 120000);
    const opt = await buildOptimizedOutput(() => {}); const ob = opt && (opt.bytes || opt);
    const sd = await PDFDocument.load(ob.slice(0));
    const L = o => sd.context.lookup(o) || o;
    const imgs = [0, 1].map(i => { const x = L(L(sd.getPage(i).node.Resources().get(N('XObject'))).get(N('Im1'))); return { f: String(x.dict.get(N('Filter'))), cs: String(x.dict.get(N('ColorSpace'))), w: String(x.dict.get(N('Width'))) }; });
    ck('사진 두 장 모두 DCTDecode · DeviceGray · 크기 그대로', imgs.every(m => m.f === '/DCTDecode' && m.cs === '/DeviceGray' && m.w === '96'), imgs);
    ck('저장 전 컬러 검수(pageIsNeutral)도 무채색', pageIsNeutral(sd, sd.getPage(0).node) && pageIsNeutral(sd, sd.getPage(1).node));
    const cc = (_optBaseCache.sig === baseSignature() && _optBaseCache.stats) ? _optBaseCache.stats.colorCheck : null;
    ck('컬러 검수 경고 없음', !cc || (!(cc.leftover || []).length && !(cc.lost || []).length), cc);
    const tout = window.electronAPI.writeTempFile(ob, 'pdf');
    return { out, tin, tout };
    } catch (e) { out.push(['✘', '예외', String(e && e.stack || e).slice(0, 500)]); return { out }; }
  })()`);

  if (res.tout) {
    // 프린터가 보는 잉크 — 흑백 쪽은 C·M·Y가 0이어야 한다
    const ink = inkcov(gsPath, res.tout);
    res.out.push([ink.length === 3 && ink.every(v => v[0] + v[1] + v[2] === 0) ? '✔' : '✘', '저장본 gs inkcov: 세 쪽 모두 C·M·Y = 0', JSON.stringify(ink)]);
    // 밝기: 원본을 gs가 회색으로 그린 것과 거의 같아야 한다(반전·깨짐이면 크게 어긋난다)
    for (const pg of [1, 2]) {
      const a = pgmMean(gsPath, res.tin, pg), b = pgmMean(gsPath, res.tout, pg);
      res.out.push([Math.abs(a - b) < 6 ? '✔' : '✘', `${pg}쪽 평균 밝기가 원본 회색 렌더와 같음(차 < 6)`, JSON.stringify([+a.toFixed(1), +b.toFixed(1)])]);
    }
    for (const f of [res.tin, res.tout]) { try { fs.unlinkSync(f); } catch (e) {} }
  }
  let fail = 0;
  res.out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.out.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
