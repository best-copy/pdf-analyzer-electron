// ⚡ 대용량 분석 가속 회귀 — Ghostscript 병렬 분석 = pdf.js 분석과 쪽별 같은 판정 · 💾 디스크 분석 캐시
//   실행: npx electron scripts/test/analyze-gs-cache.e2e.js
//   (실파일 확인은 scratchpad gs-parity 방식: 374MB 도록 146쪽 등 9개 파일 쪽별 대조)
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const { leftWin } = require('./_leftwin');

// main.js의 핸들러를 **원본 그대로 꺼내** 등록한다(복사본은 드리프트 — CLAUDE.md 7-2).
// gs 호출 횟수는 메인에서 센다 — gs가 실패해 pdf.js로 조용히 내려가면 판정 비교가 헛통과한다.
const calls = {};
function installMainHandlers() {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').split('\r\n').join('\n');   // main.js는 CRLF
  const cut = (a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error('main.js에서 못 찾음: ' + a); return src.slice(i, j); };
  const code = ['let _gsPath = null;', cut('function findGhostscript() {', '\n// gs inkcov 실행'),
    cut("ipcMain.handle('gs:renderThumbs'", '// ── IPC: 2GB')].join('\n');
  const wrap = { handle: (ch, fn) => ipcMain.handle(ch, (...a) => { calls[ch] = (calls[ch] || 0) + 1; return fn(...a); }), on: (ch, fn) => ipcMain.on(ch, fn) };
  new Function('ipcMain', 'path', 'os', 'fs', 'spawn', 'app', 'process', '__dirname', code)(wrap, path, os, fs, spawn, app, process, ROOT);
}

app.commandLine.appendSwitch('disable-gpu');
const UD = path.join(os.tmpdir(), 'pdfedit-gscache-e2e');
try { fs.rmSync(path.join(UD, 'analysis-cache'), { recursive: true, force: true }); } catch (e) {}
app.setPath('userData', UD);
app.whenReady().then(async () => {
  installMainHandlers();
  const win = new BrowserWindow({ show: true, width: 1200, height: 860, ...leftWin(1200, 860),
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
    // 합성 12쪽: 3·7·11쪽에만 작은 컬러 점(2×2pt) — 해상도·판정 규칙이 갈리면 바로 드러나는 크기
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 12; i++) {
      const p = d.addPage([420, 595]);
      p.drawText('Page ' + i, { x: 60, y: 300, size: 48, font: f, color: rgb(0.2, 0.2, 0.2) });
      p.drawRectangle({ x: 40, y: 40, width: 340, height: 6, color: rgb(0.6, 0.6, 0.6) });
      if (i % 4 === 3) p.drawRectangle({ x: 200, y: 500, width: 2, height: 2, color: rgb(0.9, 0.1, 0.1) });
    }
    const bytes = await d.save();
    const open = (name) => { const b = bytes.slice(0); startLoad([{ name, size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer) }]); };
    const closeAll = async () => { for (const id of [...tabs.keys()]) { try { closeTab(id, { force: true }); } catch (e) {} } await sleep(300); };
    const want = [3, 7, 11];

    // ① pdf.js 경로(기준)
    window.__forceGsAnalyze = false; window.__analysisDiskMinMs = 1e9;
    open('a.pdf'); ck('pdf.js 분석 완료', await waitReady());
    const ref = pageResults.map(r => r.isColor ? 1 : 0);
    ck('pdf.js: 컬러 쪽 = 3·7·11', JSON.stringify(ref.map((c, i) => c ? i + 1 : 0).filter(Boolean)) === JSON.stringify(want), ref);
    const refW = pageResults[0].thumbW;
    await closeAll();

    // ② Ghostscript 경로 — 같은 판정·같은 썸네일 크기 + 디스크 캐시 저장
    window.__forceGsAnalyze = true; window.__analysisDiskMinMs = 0;
    open('b.pdf'); ck('gs 분석 완료', await waitReady());
    const gs = pageResults.map(r => r.isColor ? 1 : 0);
    ck('gs: 쪽별 판정이 pdf.js와 같음', JSON.stringify(gs) === JSON.stringify(ref), gs);
    ck('gs: 썸네일 폭이 pdf.js와 같음(±2px)', Math.abs(pageResults[0].thumbW - refW) <= 2, [pageResults[0].thumbW, refW]);
    ck('gs: 쪽 크기(pt) 채워짐', pageResults.every(r => r.pageWpt > 400 && r.pageHpt > 590), pageResults[0].pageWpt);
    await sleep(3500);   // 캐시 저장(1.5초 뒤)
    await closeAll();

    // ③ 같은 파일 다시 열기 → 디스크 캐시
    window.__forceGsAnalyze = false; window.__analysisDiskMinMs = 1e9;
    const t0 = Date.now();
    open('c.pdf'); ck('재오픈 분석 완료', await waitReady());
    const tab = tabs.get(activeTabId);
    ck('재오픈: 디스크 캐시에서 불러옴', !!tab.analysisFromDisk, { fromDisk: tab.analysisFromDisk, ms: Date.now() - t0 });
    ck('재오픈: 판정이 같음', JSON.stringify(pageResults.map(r => r.isColor ? 1 : 0)) === JSON.stringify(ref));
    ck('재오픈: 썸네일 있음', pageResults.every(r => r.thumbnail));
    ck('재오픈: 안내 문구', /예전에 분석한 같은 파일/.test((document.getElementById('success') || {}).textContent || ''));
    await closeAll();

    // ④ 한 바이트만 달라도 캐시를 쓰지 않는다
    const b2 = bytes.slice(0); b2[b2.length - 3] = b2[b2.length - 3] === 32 ? 10 : 32;
    startLoad([{ name: 'd.pdf', size: b2.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b2.buffer) }]);
    ck('다른 바이트 분석 완료', await waitReady());
    ck('다른 바이트: 캐시 안 씀', !tabs.get(activeTabId).analysisFromDisk);
    return { out };
    } catch (e) { out.push(['✘', '예외', String(e && e.stack || e).slice(0, 500)]); return { out }; }
  })()`);

  // ②에서만 gs 경로를 강제했다 — 정확히 1번 돌아야 한다(0이면 pdf.js로 조용히 내려간 것)
  res.out.push([calls['gs:renderThumbs'] === 1 ? '✔' : '✘', 'gs 렌더가 실제로 1번 돌았음(pdf.js로 내려가지 않음)', JSON.stringify(calls)]);
  let fail = 0;
  res.out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.out.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
