// 📖 펼침 맞춤 넘기기 — 펼침 보기에서 PageDown/PageUp을 누르면 한 펼침(두 쪽)만 화면에 딱 맞게 · 2026-10-19
//   실행: npx electron scripts/test/spread-pagekey.e2e.js   (가장 왼쪽 모니터에 띄운다 — 실제 배치·스크롤을 재야 해서)
// 확인: 분석 썸네일(#pagesGrid)·결과 미리보기(#previewGrid)·편집 모드 미리보기에서
//   · 화면(위쪽 고정 막대 아래)에 보이는 쪽 = 지금 펼침의 쪽뿐(1쪽 → 2·3쪽 → 4·5쪽 …), 다른 쪽은 한 픽셀도 안 보임
//   · 그 쪽들은 잘리지 않고 다 보임 · 보이는 높이를 거의 채움(딱 맞게)
//   · PageUp으로 되돌아감 · 펼침 크기를 직접 바꾸면 맞춤이 풀림
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const { leftWin } = require('./_leftwin');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-spreadkey'));

const out = [];
const ck = (n, c, x) => { out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]); };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1400, height: 950, ...leftWin(1400, 950),
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, l, m) => { if (l >= 3 && !/No handler|Security|outlineFonts|프리웜/.test(m)) console.log('[앱오류]', m.slice(0, 300)); });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code}\n})()`);
  const key = async (k) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); await new Promise(r => setTimeout(r, 700)); };
  // 지금 화면에 보이는 쪽 번호와, 그 쪽들이 잘렸는지·영역을 얼마나 채우는지
  const probe = (gridId) => js(`
    const g = document.getElementById(${JSON.stringify(gridId)});
    const box = spreadScrollBox(g), vp = spreadViewport(box, g);
    const cells = [...g.children].filter(el => !el.classList.contains('chapter-divider') && el.offsetHeight);
    const seen = [], cut = [];
    let fill = 0, wsum = 0;
    cells.forEach((el, i) => {
      const pic = el.querySelector('.page-thumbnail, canvas') || el;
      const b = pic.getBoundingClientRect();
      if (b.bottom > vp.top + 0.5 && b.top < vp.bottom - 0.5 && b.height > 0) {
        seen.push(i + 1);
        if (b.top < vp.top - 0.5 || b.bottom > vp.bottom + 0.5) cut.push(i + 1);
        fill = Math.max(fill, b.height / (vp.bottom - vp.top)); wsum += b.width;
      }
    });
    return { seen, cut, fill: Math.round(fill * 100), wfill: Math.round(wsum / g.clientWidth * 100), fit: g.classList.contains('spread-fit'), pct: document.getElementById('zoomPct').textContent };`);

  try {
    await js(`
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 120000)) { if (f()) return true; await sleep(50); } return false; };
      window.confirm = () => true;
      const { PDFDocument, StandardFonts, rgb } = PDFLib;
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= 11; i++) { const p = d.addPage([595, 842]); p.drawText(String(i), { x: 220, y: 380, size: 160, font: f, color: rgb(0, 0, 0) }); }
      const b = await d.save();
      startLoad([{ name: '펼침.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
      await waitFor(() => pageResults.length === 11 && isTabReady(tabs.get(activeTabId)));
      await sleep(1200);
      toggleSpreadView(true);
      document.getElementById('pagesGrid').scrollIntoView({ block: 'start' });
      await sleep(800);`);

    // ── A. 분석 썸네일 ──
    await key('PageDown');
    let p = await probe('pagesGrid');
    // 처음 누름: 가장 많이 보이던 줄의 다음 펼침 — 첫 줄(1쪽)이 보이고 있었으면 2·3쪽
    ck('A 첫 PageDown → 맞춤 켜짐·한 펼침(두 쪽)만', p.fit && p.seen.length === 2 && p.seen[1] === p.seen[0] + 1 && p.seen[0] % 2 === 0, p);
    const a1 = p.seen[0];
    ck('A 잘린 쪽 없음', p.cut.length === 0, p);
    ck('A 딱 맞게 — 높이 또는 폭을 거의 채움', p.fill >= 85 || p.wfill >= 95, p);
    await key('PageDown');
    p = await probe('pagesGrid');
    ck('A 다음 PageDown → 다음 펼침만', p.seen[0] === a1 + 2 && p.seen.length === 2 && !p.cut.length, p);
    for (let i = 0; i < 6; i++) await key('PageUp');
    p = await probe('pagesGrid');
    ck('A PageUp으로 맨 앞 → 1쪽만(오른쪽 단독)', JSON.stringify(p.seen) === '[1]' && !p.cut.length, p);
    await key('PageUp');
    p = await probe('pagesGrid');
    ck('A 맨 앞에서 PageUp → 그대로 1쪽', JSON.stringify(p.seen) === '[1]', p);
    for (let i = 0; i < 7; i++) await key('PageDown');
    p = await probe('pagesGrid');
    ck('A 끝까지 → 마지막 펼침(10·11쪽)', JSON.stringify(p.seen) === '[10,11]' && !p.cut.length, p);
    const z = await js(`changeSpreadZoom(-1); await new Promise(r => setTimeout(r, 400)); return { fit: document.getElementById('pagesGrid').classList.contains('spread-fit'), pct: document.getElementById('zoomPct').textContent };`);
    ck('A 펼침 크기를 직접 바꾸면 맞춤이 풀림·%는 10 단위', !z.fit && /^\d+0%$/.test(z.pct), z);

    // ── B. 결과 미리보기(적용 후) ──
    await js(`const sleep = ms => new Promise(r => setTimeout(r, ms));
      if (!processingOptions.bw) toggleOption('bw'); selectedPages.add(2);
      invalidateProcessed(); await applyChanges(); const t = Date.now(); while (!processedPdfBytes && Date.now() - t < 60000) await sleep(50);
      await sleep(2500); document.getElementById('previewGrid').scrollIntoView({ block: 'start' }); await sleep(800);`);
    await key('PageDown');
    p = await probe('previewGrid');
    ck('B 결과 미리보기: 맞춤·한 펼침만', p.fit && (p.seen.length === 2 || JSON.stringify(p.seen) === '[1]') && !p.cut.length, p);
    await key('PageDown');
    p = await probe('previewGrid');
    ck('B 다음 펼침 · 잘림 없음 · 딱 맞게', p.seen.length === 2 && !p.cut.length && (p.fill >= 85 || p.wfill >= 95), p);
    await new Promise(r => setTimeout(r, 1500));   // 고해상도 재렌더 뒤에도 그대로인가
    const p2 = await probe('previewGrid');
    ck('B 재렌더 뒤에도 같은 펼침 그대로', JSON.stringify(p2.seen) === JSON.stringify(p.seen) && !p2.cut.length, [p, p2]);

    // ── C. 편집 모드 미리보기 ──
    await js(`const sleep = ms => new Promise(r => setTimeout(r, ms)); enterEditWorkspace(); await sleep(4000);`);
    await key('PageDown');
    p = await probe('previewGrid');
    ck('C 편집 모드: 맞춤·한 펼침만·잘림 없음', p.fit && p.seen.length >= 1 && p.seen.length <= 2 && !p.cut.length, p);
    await key('PageDown');
    const p3 = await probe('previewGrid');
    ck('C 편집 모드: 다음 펼침으로 넘어감 · 딱 맞게', p3.seen[0] > p.seen[0] && p3.seen.length <= 2 && !p3.cut.length && (p3.fill >= 85 || p3.wfill >= 95), [p, p3]);
    require('fs').writeFileSync(path.join(os.tmpdir(), 'spread-pagekey.png'), (await win.webContents.capturePage()).toPNG());
  } catch (e) { ck('실행 오류', false, e && (e.stack || e.message)); }

  let fail = 0;
  out.forEach(([m, n, x]) => { if (m !== '✔') fail++; console.log(m, n, m === '✔' ? '' : x); });
  console.log(`결과: ${out.length - fail} 통과 / ${fail} 실패`);
  app.exit(fail ? 1 : 0);
});
