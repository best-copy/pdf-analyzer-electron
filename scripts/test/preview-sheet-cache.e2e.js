// 결과 미리보기 — 임포징 시트는 바뀐 쪽이 든 시트만 다시 그린다 (app-ui renderProcessedPreview sigOf · app-process noteSheetSrc)
//   실행: npx electron scripts/test/preview-sheet-cache.e2e.js
// 예전: 시트의 캐시 열쇠가 결과 바이트 지문이라, 한 쪽만 흑백↔컬러로 바꿔 적용해도 모든 시트를 다시 그렸다
//   ('미리보기 채우는 중… n/N'이 길게). 이제 빌더가 시트마다 앉은 원고 쪽을 남기고, 열쇠는 그 쪽들의 상태다.
// 확인: 모아찍기(챕터별 강제)·중철·쪽 순서 변경에서 다시 그린 시트 수 · 화면이 '캐시 없이 전부 새로 그린 것'과 같음
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-pvsheet-e2e'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1300, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 3 && !/No handler|Security/.test(msg)) console.log('  [앱] ' + msg.slice(0, 200)); });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const out = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    try {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    window.confirm = () => true;
    const filling = () => document.querySelectorAll('#previewGrid .pv-pending').length > 0 || /채우는 중/.test(document.getElementById('previewNote').textContent);
    // 다시 그릴 칸 수는 지연 렌더 엔진이 받은 목록(cellsByIdx) 크기로 센다 — 화면 표식으로 세면 빨리 끝난 칸을 놓친다
    let drawn = 0;
    const origLazy = runLazyPreviewRender;
    runLazyPreviewRender = (ctx) => { drawn += ctx.cellsByIdx.size; return origLazy(ctx); };
    // ✔ 적용은 결과 화면 그리기를 기다리지 않고 끝난다 — 지금 결과 바이트의 화면이 붙고(_pvDoc) 다 채워질 때까지
    const shown = () => !processedPdfBytes || _pvDoc.key === bytesFingerprint(processedPdfBytes);
    const settle = async () => { for (let i = 0; i < 1500 && (applying || filling() || !shown()); i++) await sleep(20); await sleep(300); };
    const applyCount = async () => {
      await settle(); drawn = 0;
      await applyChanges(); await settle();
      return drawn;
    };
    // 화면 지문 — 시트마다 캔버스 화소 표본 합(+컬러/흑백 표식)
    const shot = () => [...document.querySelectorAll('#previewGrid .pv-cell canvas')].map(c => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0;
      for (let k = 0; k < d.length; k += 97) h = (h * 31 + d[k]) >>> 0;
      return c.width + 'x' + c.height + ':' + h + (c.closest('.pv-cell').classList.contains('pv-color') ? 'C' : 'K');
    });
    const fresh = async () => {   // 캐시를 버리고 같은 결과를 전부 다시 그린 화면
      _pvPageCache = new Map(); await renderProcessedPreview(processedPdfBytes, { live: false });
      await settle();
      return shot();
    };
    const changed = (a, b) => a.map((x, k) => x !== b[k] ? k + 1 : 0).filter(Boolean);
    // 합성: A장 6쪽 + B장 6쪽, 모두 컬러(쪽마다 다른 색 띠 + 번호)
    const d = await PDFLib.PDFDocument.create(); const f = await d.embedFont(PDFLib.StandardFonts.Helvetica); const { rgb } = PDFLib;
    for (let k = 0; k < 12; k++) { const p = d.addPage([300, 420]); p.drawRectangle({ x: 0, y: 300, width: 300, height: 120, color: rgb((k * 37 % 100) / 100, 0.3, 0.8) }); p.drawText((k < 6 ? 'A' : 'B') + (k % 6 + 1), { x: 90, y: 150, size: 60, font: f }); }
    const b = await d.save();
    startLoad([{ name: 'sheet.pdf', size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.slice(0).buffer) }]);
    for (let i = 0; i < 300 && !(pageResults.length === 12 && pageResults.every(r => r && r.thumbnail) && isTabReady(tabs.get(activeTabId))); i++) await sleep(100);
    pageResults.forEach((r, i) => { r.chapter = i < 6 ? 'A장' : 'B장'; }); rerenderPages();
    if (!processingOptions.bw) toggleOption('bw');

    // ── 1) 2쪽 모아찍기(챕터별 강제)·단면: 시트 6장 ──
    setImpMode('nup'); setCutSides(1);
    document.getElementById('impAcross').value = '2'; document.getElementById('impDown').value = '1';
    if (!_impEnabled) toggleImpEnabled(true);
    const n0 = await applyCount();
    const s0 = shot();
    const sheets = document.querySelectorAll('#previewGrid .pv-cell').length;
    ck('전제: 시트 6장 · 처음엔 전부 그림', sheets === 6 && n0 === 6, { sheets, n0 });
    { const m = typeof _impSheetSrcOf !== 'undefined' && _impSheetSrcOf.get(processedPdfBytes); ck('시트 → 원고 쪽 대응이 남음', !!(m && m.map.length === 6), m && m.map); }
    selectedPages.add(3); updateSelectedCount();          // A3 흑백 → 2번 시트(A3 A4)만
    const n1 = await applyCount();
    ck('한 쪽 흑백 → 그 쪽이 든 시트 1장만 다시 그림', n1 === 1, { 다시그림: n1 });
    const s1 = shot(), f1 = await fresh();
    ck('화면 = 캐시 없이 새로 그린 것', JSON.stringify(s1) === JSON.stringify(f1), { s1, f1 });
    ck('그림이 달라진 시트는 2번(A3 A4)뿐', JSON.stringify(changed(s0, s1)) === '[2]', changed(s0, s1));
    toggleOption('bw');   // 다시 컬러로 — ✔ 적용으로 확정된 흑백은 흑백변환 옵션을 꺼야 풀린다(app-core toggleOption)
    const n2 = await applyCount();
    const s2 = shot();
    ck('다시 컬러로 → 1장만 · 처음 화면과 같음', n2 === 1 && JSON.stringify(s2) === JSON.stringify(s0), { n2, 달라진시트: changed(s0, s2) });
    toggleOption('bw');   // 다음 단계를 위해 다시 켠다(확정은 풀린 채)

    // ── 2) 쪽 순서 변경(A1 ↔ A2 맞바꿈) — 1번 시트만 달라진다 ──
    const t = pageResults[0]; pageResults[0] = pageResults[1]; pageResults[1] = t; rebuildPageNums && rebuildPageNums(); rerenderPages(); invalidateProcessed();
    const n3 = await applyCount();
    const s3 = shot(), f3 = await fresh();
    ck('쪽 순서 변경 → 바뀐 시트만 다시 그림 · 새로 그린 것과 같음', n3 >= 1 && n3 <= 2 && JSON.stringify(s3) === JSON.stringify(f3), { n3 });

    // ── 3) 중철(한 권) — 4쪽 흑백: 그 쪽이 앉은 시트 면 1장만 ──
    setImpMode('booklet');
    const n4 = await applyCount();
    const sh4 = document.querySelectorAll('#previewGrid .pv-cell').length;
    selectedPages.add(4); updateSelectedCount();
    const n5 = await applyCount();
    const s5 = shot(), f5 = await fresh();
    ck('중철: 한 쪽 흑백 → 1장만 · 새로 그린 것과 같음', n5 === 1 && JSON.stringify(s5) === JSON.stringify(f5), { 시트: sh4, 처음: n4, 다시그림: n5 });

    // ── 4) 임포징 옵션(거터)을 바꾸면 전부 다시 ──
    document.getElementById('bkGutter').value = '5';
    if (typeof impSettingsChanged === 'function') impSettingsChanged();
    const n6 = await applyCount();
    ck('임포징 옵션 변경 → 전부 다시 그림', n6 === sh4, { n6, sh4 });
    } catch (e) { out.push(['✘', '예외', String(e && e.stack || e).slice(0, 500)]); }
    return out;
  })()`);
  let fail = 0;
  out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${out.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
