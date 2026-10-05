// 🎯 컬러 판정 보정 회귀 — 먹(K만)·C=M=Y 회색을 렌더가 컬러로 센 쪽을 흑백으로 (app-core refineNeutralPages)
//   실행: npx electron scripts/test/analyze-neutral-refine.e2e.js
//   ① 내용 확인(pageIsNeutral)으로 풀리는 쪽 · ② 내용으로는 모르는(RGB·CMYK 사진) '거의 회색' 쪽 = gs -dUseFastColor 재확인
//   진짜 컬러(옅은 색조 포함)는 그대로 컬러여야 하고, 색이 진한 쪽은 다시 그리지 않아야 한다.
//   pdf.js 경로·gs 경로·내부 편집 재판정(regenEditedThumbs) 셋 다.
//   (실파일 확인: 도록 146쪽 → 14쪽 흑백, 나머지 21개 파일 1,066쪽 변화 0 — 2026-10-05)
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const { leftWin } = require('./_leftwin');

// main.js 핸들러를 원본 그대로 꺼내 등록(analyze-gs-cache.e2e.js와 같은 방식) — 재확인 호출의 쪽 목록을 기록한다
const renders = [];
function installMainHandlers() {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').split('\r\n').join('\n');
  const cut = (a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error('main.js에서 못 찾음: ' + a); return src.slice(i, j); };
  const code = ['let _gsPath = null;', cut('function findGhostscript() {', '\n// gs inkcov 실행'),
    cut("ipcMain.handle('gs:renderThumbs'", '// ── IPC: 2GB')].join('\n');
  const wrap = { handle: (ch, fn) => ipcMain.handle(ch, (...a) => { if (ch === 'gs:renderThumbs') renders.push(a[2] || {}); return fn(...a); }), on: (ch, fn) => ipcMain.on(ch, fn) };
  new Function('ipcMain', 'path', 'os', 'fs', 'spawn', 'app', 'process', '__dirname', code)(wrap, path, os, fs, spawn, app, process, ROOT);
}

app.commandLine.appendSwitch('disable-gpu');
const UD = path.join(os.tmpdir(), 'pdfedit-neutral-e2e');
try { fs.rmSync(path.join(UD, 'analysis-cache'), { recursive: true, force: true }); } catch (e) {}
app.setPath('userData', UD);
app.whenReady().then(async () => {
  installMainHandlers();
  const win = new BrowserWindow({ show: false, width: 1200, height: 860, ...leftWin(1200, 860),
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 2 && !/Security Warning|willReadFrequently|No handler registered/.test(msg)) console.log('  [앱] ' + msg.slice(0, 300)); });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    try {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitReady = async () => { for (let i = 0; i < 1200; i++) { if (pageResults.length && pageResults.every(r => r && r.thumbnail) && activeTabId && isTabReady(tabs.get(activeTabId))) return true; await sleep(100); } return false; };
    const { PDFDocument, PDFName } = PDFLib;
    // 그림 하나(Flate) + 콘텐츠 스트림으로 한 쪽 — 그림 픽셀은 fn(x,y) → 성분 배열
    async function build(pages) {
      const d = await PDFDocument.create(); const ctx = d.context;
      for (const pg of pages) {
        const p = d.addPage([420, 595]);
        let ops = pg.ops;
        if (pg.img) {
          const { cs, n, fn } = pg.img, W = 64, H = 48, px = new Uint8Array(W * H * n);
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set(fn(x, y).map(v => Math.round(v * 255)), (y * W + x) * n);
          const ref = ctx.register(ctx.flateStream(px, { Type: 'XObject', Subtype: 'Image', Width: W, Height: H, ColorSpace: cs, BitsPerComponent: 8 }));
          p.node.setXObject(PDFName.of('Im1'), ref);
          ops = 'q 240 0 0 180 90 330 cm /Im1 Do Q ' + ops;
        }
        p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(ops)));
      }
      return d.save();
    }
    const K = '0 0 0 1 k 60 60 300 40 re f 0 0 0 0.6 k 60 120 300 40 re f';   // 먹만(K 100%·60%)
    const PAGES = [
      { name: '1 먹만(K) 벡터 → ①', ops: K },
      { name: '2 먹 + 회색 RGB 사진 → ②', ops: K, img: { cs: 'DeviceRGB', n: 3, fn: (x, y) => { const v = (x + y) / 112; return [v, v, v]; } } },
      { name: '3 먹 + C=M=Y CMYK 사진 → ②', ops: K, img: { cs: 'DeviceCMYK', n: 4, fn: (x, y) => { const v = x / 64 * 0.5; return [v, v, v, y / 48 * 0.4]; } } },
      { name: '4 먹 + 옅은 색조 RGB 사진(진짜 컬러)', ops: K, img: { cs: 'DeviceRGB', n: 3, fn: (x, y) => { const v = 0.3 + (x + y) / 300; return [v + 0.06, v, v]; } } },
      { name: '5 진한 컬러 RGB 사진', ops: K, img: { cs: 'DeviceRGB', n: 3, fn: (x, y) => [0.9, 0.2 + y / 100, 0.1] } },
      { name: '6 회색(g)만', ops: '0.5 g 60 60 300 40 re f' },
      { name: '7 먹 + 진한 CMYK 별색 아님(C만)', ops: K + ' 1 0 0 0 k 60 200 40 40 re f' },
    ];
    const wantColor = [4, 5, 7];
    const bytes = await build(PAGES);
    const open = (name, b) => { b = b.slice(0); startLoad([{ name, size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer) }]); };
    const closeAll = async () => { for (const id of [...tabs.keys()]) { try { closeTab(id, { force: true }); } catch (e) {} } await sleep(300); };
    const colourPages = () => pageResults.map((r, i) => r.isColor ? i + 1 : 0).filter(Boolean);

    // 보정 전 판정(렌더만)도 기록 — 1~3쪽이 렌더로는 컬러여야 이 검사가 의미가 있다
    const pjs = await openPdfDoc({ data: bytes.slice(0) }).promise; const raw = [];
    for (let i = 1; i <= PAGES.length; i++) { const r = await analyzePageColor(await pjs.getPage(i)); raw.push(r.isColor ? 1 : 0); }
    pjs.destroy();
    ck('전제: 렌더만으로는 1~3쪽이 컬러(먹이 따뜻하게 그려짐)', raw[0] && raw[1] && raw[2], raw);

    for (const viaGs of [false, true]) {
      const tag = viaGs ? 'gs 경로' : 'pdf.js 경로';
      window.__forceGsAnalyze = viaGs; window.__analysisDiskMinMs = 1e9;
      window.__rendersBefore = 0;
      open(viaGs ? 'g.pdf' : 'p.pdf', bytes); ck(tag + ': 분석 완료', await waitReady());
      ck(tag + ': 컬러 쪽 = 4·5·7 (1·2·3·6 흑백)', JSON.stringify(colourPages()) === JSON.stringify(wantColor), colourPages());
      ck(tag + ': 컬러/흑백 장수', tabs.get(activeTabId).colorCount === 3 && tabs.get(activeTabId).bwCount === 4, [tabs.get(activeTabId).colorCount, tabs.get(activeTabId).bwCount]);
      if (!viaGs) {
        // 내부 편집 재판정: 6쪽(회색)을 1쪽(먹만) 내용으로 바꿔 넣으면 — 렌더는 컬러지만 보정 뒤 흑백
        const one = await PDFDocument.create(); const s = await PDFDocument.load(bytes.slice(0));
        const [cp] = await one.copyPages(s, [0]); one.addPage(cp);
        contentEdits.set(5, { bytes: await one.save() });
        pageResults[5].isColor = true;   // 일부러 틀린 값에서 시작
        await regenEditedThumbs([5]);
        ck('내부 편집 재판정: 먹만인 편집본 = 흑백', pageResults[5].isColor === false, pageResults[5].isColor);
        contentEdits.delete(5);
      }
      await closeAll();
    }

    // 보정 전에 저장된 옛 디스크 캐시(meta.nv 없음, 1쪽 컬러) — 열 때 내용 확인으로 1쪽이 흑백이 돼야 한다
    window.__forceGsAnalyze = false; window.__analysisDiskMinMs = 0;
    open('c1.pdf', bytes); await waitReady(); await sleep(3500); await closeAll();
    const key = await pdfFingerprint(bytes); const hit = await readAnalysisDiskCache(key);
    ck('디스크 캐시 저장됨 + 보정 표시(nv)', !!(hit && hit.meta.nv === 1), hit && hit.meta.nv);
    if (hit) {
      delete hit.meta.nv; hit.meta.pages.forEach(p => { if (p.oi === 0) p.isColor = true; });
      const js = new TextEncoder().encode(JSON.stringify(hit.meta)), head = new TextEncoder().encode(ANALYSIS_DISK_MAGIC);
      const buf = new Uint8Array(head.length + 4 + js.length + hit.blob.length);
      buf.set(head, 0); new DataView(buf.buffer).setUint32(head.length, js.length, true); buf.set(js, head.length + 4); buf.set(hit.blob, head.length + 4 + js.length);
      await window.electronAPI.analysisCacheWrite(key, buf);
      window.__analysisDiskMinMs = 1e9;
      open('c2.pdf', bytes); await waitReady();
      ck('옛 캐시로 열기: 캐시에서 불러옴', !!tabs.get(activeTabId).analysisFromDisk);
      ck('옛 캐시로 열기: 1쪽 흑백으로 보정(컬러 4·5·7)', JSON.stringify(colourPages()) === JSON.stringify(wantColor), colourPages());
      await closeAll();
    }
    return { out };
    } catch (e) { out.push(['✘', '예외', String(e && e.stack || e).slice(0, 500)]); return { out }; }
  })()`);

  // 재확인(fastColor) 호출은 '거의 회색' 쪽(2·3·4)만 — 진한 컬러(5·7)와 ①로 풀린 쪽(1)은 다시 그리지 않는다
  const fast = renders.filter(o => o.fastColor);
  const lists = fast.map(o => JSON.stringify(o.pageList));
  res.out.push([fast.length >= 2 && lists.slice(0, 2).every(l => l === '[2,3,4]') ? '✔' : '✘', '재확인은 2·3·4쪽만 다시 그림(두 경로 모두)', lists.join(' ')]);
  res.out.push([fast.every(o => o.quiet) ? '✔' : '✘', '재확인은 진행 알림 없음(quiet)']);
  let fail = 0;
  res.out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.out.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
