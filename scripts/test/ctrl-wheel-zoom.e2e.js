// Ctrl+마우스 휠 = 썸네일 크기(일반) / 펼침 크기(펼침 모드) · 2026-10-19
//   실행: npx electron scripts/test/ctrl-wheel-zoom.e2e.js   (가장 왼쪽 모니터에 띄운다 — 실제 휠 입력을 보내야 해서)
// 확인: 쪽 목록 위 Ctrl+휠 한 칸 = 한 단계(위 = 확대 · 아래 = 축소) · 화면 전체 확대(브라우저 줌)는 그대로 ·
//       펼침 모드에서는 펼침 % · 왼쪽 사이드바 위에서는 사이드바 썸네일 크기만 · 터치패드식 작은 값은 모아서 한 단계 ·
//       Ctrl 없는 휠은 크기를 바꾸지 않음
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const { leftWin } = require('./_leftwin');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-ctrlwheel'));

const out = [];
const ck = (n, c, x) => { out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]); };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1400, height: 950, ...leftWin(1400, 950),
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, l, m) => { if (l >= 3 && !/No handler|Security|outlineFonts|프리웜/.test(m)) console.log('[앱오류]', m.slice(0, 300)); });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code}\n})()`);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 요소 가운데에 휠 — up=true면 위로 굴림(확대)
  const wheel = async (sel, up, ctrl, dy, times) => {
    const p = await js(`const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 150)); const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(b.height / 2, 200)) };`);
    const d = dy || 120;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
    for (let i = 0; i < (times || 1); i++) {   // 터치패드처럼 잇달아(30ms 간격)
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: up ? d : -d, wheelTicksX: 0, wheelTicksY: (up ? d : -d) / 120, canScroll: true, modifiers: ctrl ? ['control'] : [] });
      await sleep(30);
    }
    await sleep(250);
    return p;
  };
  const state = () => js(`return { thumb: thumbStepIdx, spread: typeof _spreadZoomPct !== 'undefined' ? Math.round(_spreadZoomPct) : null, pct: document.getElementById('zoomPct').textContent,
    sb: typeof _sbThumbPct !== 'undefined' ? _sbThumbPct : null, zf: null };`);

  try {
    await js(`
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 120000)) { if (f()) return true; await sleep(50); } return false; };
      const { PDFDocument, StandardFonts } = PDFLib;
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= 16; i++) d.addPage([595, 842]).drawText('P' + i, { x: 40, y: 400, size: 60, font: f });
      const b = await d.save();
      startLoad([{ name: '휠.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
      await waitFor(() => pageResults.length === 16 && isTabReady(tabs.get(activeTabId)));
      await sleep(1000);`);

    // ── 일반 모드 ──
    let s0 = await state();
    await wheel('#pagesGrid .page-item:nth-child(3)', true, true);
    let s1 = await state();
    ck('일반: Ctrl+휠 위 한 칸 → 썸네일 한 단계 확대', s1.thumb === s0.thumb + 1, [s0, s1]);
    ck('일반: 화면 전체 확대(브라우저 줌)는 그대로', win.webContents.getZoomFactor() === 1, win.webContents.getZoomFactor());
    await wheel('#pagesGrid .page-item:nth-child(3)', false, true);
    await wheel('#pagesGrid .page-item:nth-child(3)', false, true);
    let s2 = await state();
    ck('일반: Ctrl+휠 아래 두 칸 → 두 단계 축소', s2.thumb === s1.thumb - 2, [s1, s2]);
    await wheel('#pagesGrid .page-item:nth-child(3)', true, false);
    let s3 = await state();
    ck('일반: Ctrl 없는 휠은 크기 그대로', s3.thumb === s2.thumb, [s2, s3]);
    // 터치패드식 — 작은 값 4번(합 60) → 한 단계
    await wheel('#pagesGrid .page-item:nth-child(3)', true, true, 15, 4);
    let s4 = await state();
    ck('일반: 작은 휠 값은 모아서 한 단계', s4.thumb === s3.thumb + 1, [s3, s4]);
    // 큰 값 한 번(360) → 한 단계까지만
    await wheel('#pagesGrid .page-item:nth-child(3)', true, true, 360);
    let s5 = await state();
    ck('일반: 큰 휠 값 한 번에 한 단계까지만', s5.thumb === s4.thumb + 1, [s4, s5]);

    // ── 왼쪽 사이드바 ──
    const sb0 = await state();
    // 사이드바 아래쪽(위의 고정 패널을 피해) 썸네일 자리
    const sp = await js(`const sb = document.getElementById('thumbSidebar').getBoundingClientRect(); return { x: Math.round(sb.left + sb.width / 2), y: Math.round(sb.bottom - 80) };`);
    const hit = await js(`const e = document.elementFromPoint(${sp.x}, ${sp.y}); return !!(e && e.closest('#thumbSidebar') && !e.closest('#sbPanel'));`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: sp.x, y: sp.y });
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: sp.x, y: sp.y, deltaX: 0, deltaY: 120, wheelTicksX: 0, wheelTicksY: 1, canScroll: true, modifiers: ['control'] });
    await sleep(300);
    ck('사이드바 썸네일 자리에 휠을 보냄', hit);
    const sb1 = await state();
    ck('사이드바 위: 사이드바 썸네일만 커지고 가운데 목록은 그대로', sb1.sb > sb0.sb && sb1.thumb === sb0.thumb, [sb0, sb1]);

    // ── 펼침 모드 ──
    await js(`toggleSpreadView(true); await new Promise(r => setTimeout(r, 600));`);
    const p0 = await state();
    await wheel('#pagesGrid .page-item:nth-child(4)', true, true);
    const p1 = await state();
    ck('펼침: Ctrl+휠 위 → 펼침 크기 +10%', p1.spread === p0.spread + 10 && p1.thumb === p0.thumb, [p0, p1]);
    await wheel('#pagesGrid .page-item:nth-child(4)', false, true);
    await wheel('#pagesGrid .page-item:nth-child(4)', false, true);
    const p2 = await state();
    ck('펼침: Ctrl+휠 아래 두 칸 → -20%', p2.spread === p1.spread - 20, [p1, p2]);
    ck('펼침: 위젯 % 표시도 같이', p2.pct === p2.spread + '%', p2);
    ck('펼침: 화면 전체 확대는 그대로', win.webContents.getZoomFactor() === 1, win.webContents.getZoomFactor());

    // ── 결과 미리보기(적용 후) 위에서도 ──
    await js(`const sleep = ms => new Promise(r => setTimeout(r, ms)); toggleSpreadView(false);
      if (!processingOptions.bw) toggleOption('bw'); selectedPages.add(1);
      invalidateProcessed(); await applyChanges(); const t = Date.now(); while (!processedPdfBytes && Date.now() - t < 60000) await sleep(50); await sleep(2000);`);
    const r0 = await state();
    await wheel('#previewGrid .pv-cell:nth-child(2)', true, true);
    const r1 = await state();
    ck('결과 미리보기 위: Ctrl+휠로 썸네일 확대', r1.thumb === r0.thumb + 1, [r0, r1]);
  } catch (e) { ck('실행 오류', false, e && (e.stack || e.message)); }

  let fail = 0;
  out.forEach(([m, n, x]) => { if (m !== '✔') fail++; console.log(m, n, m === '✔' ? '' : x); });
  console.log(`결과: ${out.length - fail} 통과 / ${fail} 실패`);
  app.exit(fail ? 1 : 0);
});
