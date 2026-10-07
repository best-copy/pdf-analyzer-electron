// 흑백변환 — /Mask(마스킹) 그림의 배경이 검게 변하던 회귀 (app-process convertXObjectImageToGrayscale · colorKeyToStencil)
//   실행: npx electron scripts/test/bw-image-mask.e2e.js
// 변환기들이 회색으로 바꾸며 /Mask를 지워, 스텐실로 비워 둔 배경(표본은 검정)이 드러났다
// (실파일 '사업계획서-3부' 5쪽: 띠 그림 190장 → 흑백에서 그림 배경이 새까맣게). 이제
//   · /Mask가 스텐실 그림이면 그대로 둔다(색공간과 무관)
//   · 색 키 배열([min max …])은 원래 표본 기준이라 변환 전에 1비트 스텐실 그림으로 바꾼다
// 확인: 저장본 /Mask · 원본 gs 회색 렌더와 평균 밝기 · gs inkcov C=M=Y=0
//   1쪽 스텐실 /Mask · 2쪽 색 키 배열 · 3쪽 색 키 + PNG 예측자(Flate 15)
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

let gsPath = null;
function installMainHandlers() {   // main.js 원본 그대로(gs 경로)
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').split('\r\n').join('\n');
  const cut = (a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error('main.js에서 못 찾음: ' + a); return src.slice(i, j); };
  const code = ['let _gsPath = null;', cut('function findGhostscript() {', '\n// gs inkcov 실행'),
    cut("ipcMain.handle('gs:renderThumbs'", '// ── IPC: 2GB'), 'return findGhostscript;'].join('\n');
  return new Function('ipcMain', 'path', 'os', 'fs', 'spawn', 'app', 'process', '__dirname', code)(ipcMain, path, os, fs, spawn, app, process, ROOT);
}
// fast: 원본은 -dUseFastColor로 그린다 — 기본 ICC 렌더는 빨강을 앱 공식(0.299R…)보다 밝은 회색으로 바꿔 차이가 난다
const pgmMean = (gs, file, page, fast) => {
  const b = execFileSync(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pgmraw', '-r72', ...(fast ? ['-dUseFastColor'] : []), `-dFirstPage=${page}`, `-dLastPage=${page}`, '-o', '-', file], { maxBuffer: 64 << 20 });
  let i = 0; const f = [];
  while (f.length < 4) { let s = ''; while (b[i] > 32) s += String.fromCharCode(b[i++]); i++; if (s && s[0] !== '#') f.push(s); }
  const px = b.subarray(i); let s = 0; for (const v of px) s += v; return s / px.length;
};
const inkcov = (gs, file) => execFileSync(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=inkcov', '-r72', '-o', '-', file], { encoding: 'latin1' })
  .split(/\r?\n/).map(l => l.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+CMYK/)).filter(Boolean).map(m => m.slice(1, 5).map(Number));

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-bwmask-e2e'));
app.whenReady().then(async () => {
  gsPath = installMainHandlers()();
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 2 && /마스크|Mask/.test(msg)) console.log('  [앱] ' + msg.slice(0, 200)); });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    try {
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 60000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const { PDFDocument, PDFName } = PDFLib; const N = n => PDFName.of(n);
    // 40×40 RGB: 가운데 20×20만 빨강, 나머지는 검정(= 마스크로 비울 곳)
    const W = 40, inC = (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30;
    const rgb = new Uint8Array(W * W * 3);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (inC(x, y)) rgb[(y * W + x) * 3] = 255;
    const stencil = new Uint8Array(5 * W);   // 1 = 칠하지 않음
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (!inC(x, y)) stencil[y * 5 + (x >> 3)] |= 0x80 >> (x & 7);
    const pred = new Uint8Array(W * (W * 3 + 1));   // PNG 예측자 None 행
    for (let y = 0; y < W; y++) pred.set(rgb.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1);

    const d = await PDFDocument.create(); const ctx = d.context;
    const img = (data, extra) => ctx.register(ctx.stream(pako.deflate(data), Object.assign({ Type: 'XObject', Subtype: 'Image', Width: W, Height: W, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' }, extra)));
    const sRef = ctx.register(ctx.stream(pako.deflate(stencil), { Type: 'XObject', Subtype: 'Image', Width: W, Height: W, ImageMask: true, BitsPerComponent: 1, Filter: 'FlateDecode' }));
    const imgs = [
      img(rgb, { Mask: sRef }),
      img(rgb, { Mask: [0, 0, 0, 0, 0, 0] }),
      img(pred, { Mask: [0, 0, 0, 0, 0, 0], DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: W } }),
    ];
    for (const ref of imgs) {
      const p = d.addPage([300, 220]); p.node.setXObject(N('Im1'), ref);
      p.node.set(N('Contents'), ctx.register(ctx.flateStream('q 200 0 0 200 50 10 cm /Im1 Do Q')));
    }
    const bytes = await d.save();
    const tin = window.electronAPI.writeTempFile(bytes, 'pdf');

    startLoad([{ name: 'mask.pdf', size: bytes.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(bytes.slice(0).buffer) }]);
    await waitFor(() => pageResults.length === 3 && pageResults.every(r => r && r.thumbnail) && isTabReady(tabs.get(activeTabId)), 120000);
    ck('전제: 세 쪽 모두 컬러로 판정', pageResults.every(r => r.isColor), pageResults.map(r => r.isColor));
    processingOptions.bw = true; processingOptions.inkNorm = true;
    selectedPages.clear(); [1, 2, 3].forEach(n => selectedPages.add(n));
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 120000);
    const opt = await buildOptimizedOutput(() => {}); const ob = opt && (opt.bytes || opt);
    const sd = await PDFDocument.load(ob.slice(0));
    const L = o => sd.context.lookup(o) || o;
    const info = [0, 1, 2].map(i => {
      const x = L(L(sd.getPage(i).node.Resources().get(N('XObject'))).get(N('Im1')));
      const m = x.dict.get(N('Mask')); const mo = m && L(m);
      return { cs: String(x.dict.get(N('ColorSpace'))), mask: !m ? '없음' : mo.dict ? (String(mo.dict.get(N('ImageMask'))) === 'true' ? '스텐실' : '그림?') : '배열' };
    });
    ck('세 그림 모두 DeviceGray', info.every(m => m.cs === '/DeviceGray'), info);
    ck('1쪽: 스텐실 /Mask 그대로', info[0].mask === '스텐실', info[0]);
    ck('2·3쪽: 색 키 배열 → 스텐실 그림', info[1].mask === '스텐실' && info[2].mask === '스텐실', info.slice(1));
    const tout = window.electronAPI.writeTempFile(ob, 'pdf');
    return { out, tin, tout };
    } catch (e) { out.push(['✘', '예외', String(e && e.stack || e).slice(0, 500)]); return { out }; }
  })()`);

  if (res.tout) {
    const ink = inkcov(gsPath, res.tout);
    res.out.push([ink.length === 3 && ink.every(v => v[0] + v[1] + v[2] === 0) ? '✔' : '✘', '저장본 gs inkcov: 세 쪽 모두 C·M·Y = 0', JSON.stringify(ink)]);
    // 배경이 검게 드러나면 평균 밝기가 크게 떨어진다(40×40 중 3/4가 검정)
    for (const pg of [1, 2, 3]) {
      const a = pgmMean(gsPath, res.tin, pg, true), b = pgmMean(gsPath, res.tout, pg);
      res.out.push([Math.abs(a - b) < 3 ? '✔' : '✘', `${pg}쪽 평균 밝기가 원본 회색 렌더와 같음(차 < 3 — 배경이 검게 드러나지 않음)`, JSON.stringify([+a.toFixed(1), +b.toFixed(1)])]);
    }
    for (const f of [res.tin, res.tout]) { try { fs.unlinkSync(f); } catch (e) {} }
  }
  let fail = 0;
  res.out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.out.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
