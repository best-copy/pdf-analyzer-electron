// ✏ 편집 모드에 들어갔을 때 오른쪽이 '빈 화면'으로 남지 않는지
//   실행: npx electron scripts/test/ws-empty-preview.e2e.js                 (합성 문서)
//         set WSE_PDF=D:\...\문서.pdf & npx electron scripts/test/ws-empty-preview.e2e.js
// 회귀: 흑백만 적용한 뒤 편집 모드로 들어가면 조립(buildBaseProcessed)이 끝날 때까지
//   아무것도 그리지 않아 오른쪽이 통째로 비었다(사용자 캡처 2026-09-29).
//   조립 캐시는 적용 직후에도 식을 수 있다(선택이 풀리며 서명이 바뀜) → 수십 초 빈 화면.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-wsempty'));
const PDF = process.env.WSE_PDF || '';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 300000)) { if (f()) return true; await sleep(100); } return false; };
    setOutlineEnabled(false);

    const pdf = ${JSON.stringify(PDF)};
    if (pdf) {
      const ab = await window.electronAPI.readFile(pdf);
      const u8 = new Uint8Array(ab);
      startLoad([{ name: 'doc.pdf', size: u8.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(u8.buffer.slice(0)) }]);
    } else {
      const { PDFDocument, StandardFonts, rgb } = PDFLib;
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= 12; i++) { const p = d.addPage([595, 842]);
        p.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0.15, 0.35, 0.85) });
        p.drawText('P' + i, { x: 40, y: 760, size: 30, font: f, color: rgb(0, 0, 0) }); }
      const b = await d.save();
      startLoad([{ name: 's.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
    }
    await waitFor(() => pageResults.length && pageResults.every(x => x && x.thumbnail), 300000);

    // 흑백만 적용 (사용자 흐름)
    if (!processingOptions.bw) toggleOption('bw');
    pageResults.forEach(r => selectedPages.add(r.pageNum));
    invalidateProcessed(); await applyChanges(); await waitFor(() => !!processedPdfBytes, 600000);

    // 조립 캐시를 식힌다 — 사용자의 실제 상태(적용 뒤 서명이 바뀐 경우)와 같게
    if (typeof clearProcessCaches === 'function') clearProcessCaches();
    const drawnCells = () => {
      const cells = [...document.querySelectorAll('#previewGrid > *')];
      let drawn = 0;
      for (const c of cells) {
        const cv = c.querySelector('canvas');
        if (!cv || !cv.width) continue;
        const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, Math.min(cv.height, 50)).data;
        let ink = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 245 || d[i+1] < 245 || d[i+2] < 245) ink++;
        if (ink > 20) drawn++;
      }
      return { cells: cells.length, drawn, shown: document.getElementById('previewSection').style.display };
    };

    const t = Date.now();
    enterEditWorkspace();
    // 1.5초 안에 뭔가 보여야 한다 (빈 화면 금지)
    let early = null;
    const okEarly = await waitFor(() => { early = drawnCells(); return early.drawn > 0; }, 1500);
    ck('편집 모드 진입 1.5초 안에 쪽이 보인다', okEarly, { ms: Date.now() - t, ...early });
    ck('미리보기 영역이 열려 있다', early.shown !== 'none', early.shown);

    // 조립이 끝나면 결과(흑백)로 바뀌고 표시도 제자리로
    const gray = async () => { const c = document.querySelector('#previewGrid canvas'); if (!c || !c.width) return null;
      const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
      let s = 0, n = 0; for (let i = 0; i < d.length; i += 4) { const mx = Math.max(d[i], d[i+1], d[i+2]), mn = Math.min(d[i], d[i+1], d[i+2]); if (mx - mn > 18) s++; n++; }
      return 100 * s / n; };
    const okGray = await waitFor(async () => false || (await gray()) < 1.5, 180000);
    ck('조립이 끝나면 결과(흑백)로 바뀐다', okGray, await gray());
    await waitFor(() => /결과 미리보기/.test(document.getElementById('pvViewNote').textContent), 20000);
    ck('한 줄 표시가 결과로 정리된다', /결과 미리보기/.test(document.getElementById('pvViewNote').textContent),
       document.getElementById('pvViewNote').textContent);
    // 지연 렌더라 화면에 보이는 칸만 그린다(창 높이만큼) — 첫 화면분이 그려졌으면 정상
    // 지연 렌더라 화면에 보이는 칸만 그린다(창 높이만큼) — 첫 화면분이 그려졌으면 정상
    ck('첫 화면 칸들이 그려졌다', (() => { const s = drawnCells(); return s.drawn >= Math.min(s.cells, 3); })(), drawnCells());

    // ── 진짜 원인: '적용 중'에 편집 모드로 들어가면 미리보기 요청이 대기열에만 남아 빈 화면이었다 ──
    exitEditWorkspace(false);
    await sleep(600);
    closePreview();                                // 빈 화면에서 시작 (앞 렌더가 남아 있으면 검사가 무의미)
    document.getElementById('previewGrid').innerHTML = '';
    await sleep(200);
    ck('빈 화면에서 시작', drawnCells().cells === 0, drawnCells());
    if (typeof clearProcessCaches === 'function') clearProcessCaches();
    invalidateProcessed();
    pageResults.forEach(r => selectedPages.add(r.pageNum));
    const applyP = applyChanges();                 // 기다리지 않는다
    await sleep(120);                              // 적용이 도는 중
    ck('적용이 도는 중인지 확인', applying === true, applying);
    enterEditWorkspace();                          // 이 순간 들어간다 (사용자 흐름)
    const t2 = Date.now();
    let mid = null;
    const okMid = await waitFor(() => { mid = drawnCells(); return mid.drawn > 0; }, 4000);
    ck('적용 중에 들어가도 4초 안에 쪽이 보인다', okMid, { ms: Date.now() - t2, ...mid });
    await applyP;
    const okAfter = await waitFor(() => drawnCells().drawn > 0, 180000);
    ck('적용이 끝난 뒤에도 화면이 비지 않는다', okAfter, drawnCells());
    return out;
  })()`);

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
