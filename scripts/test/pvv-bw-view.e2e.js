// 🔍 크게 보기 — 흑백 대상 쪽은 흑백변환 결과로 보여야 한다 (app-ui pvvRender · pvvBwPage)
//   실행: npx electron scripts/test/pvv-bw-view.e2e.js
// 사용자 지적(2026-10-07): 흑백 적용 후 페이지 크게 보기를 하면 컬러로 보였다 — 크게 보기는 늘 원본을 그렸다.
// 확인: 흑백 지정 전 = 컬러 픽셀 있음 · 지정 후(흑백변환 켬) = 컬러 픽셀 0 · 창 안 B로 해제하면 다시 컬러
//       · '✔ 적용'으로 확정된 뒤에도 흑백 · 흑백변환을 끄면 원본(컬러)
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-pvvbw-e2e'));
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
    const d = await PDFLib.PDFDocument.create(); const { rgb } = PDFLib;
    for (let k = 0; k < 2; k++) { const p = d.addPage([300, 400]); p.drawRectangle({ x: 40, y: 80, width: 220, height: 240, color: rgb(0.9, 0.2, 0.1) }); p.drawRectangle({ x: 60, y: 20, width: 100, height: 30, color: rgb(0.1, 0.3, 0.9) }); }
    const b = await d.save();
    startLoad([{ name: 'pvv.pdf', size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.slice(0).buffer) }]);
    for (let i = 0; i < 300 && !(pageResults.length === 2 && pageResults.every(r => r && r.thumbnail) && isTabReady(tabs.get(activeTabId))); i++) await sleep(100);
    // 그림이 다 그려질 때까지(_pvvBase가 새로 생길 때까지) 기다린 뒤 컬러 픽셀 수
    const view = async () => {
      _pvvBase = null; pvvRender();
      for (let i = 0; i < 300 && !_pvvBase; i++) await sleep(50);
      await sleep(100);
      const s = document.getElementById('pvvStat').textContent, v = document.getElementById('pvvVerdict').textContent;
      const m = s.match(/컬러 픽셀 ([\\d,]+)개/);
      return { colored: m ? +m[1].replace(/,/g, '') : 0, stat: s, verdict: v };
    };
    pvvOpen(0); await sleep(200);
    const a = await view();
    ck('흑백 지정 전: 원본 그대로 컬러', a.colored > 1000, a);
    if (!processingOptions.bw) toggleOption('bw');
    pvvToggleBw(); await sleep(100);
    const b2 = await view();
    ck('흑백 지정(창 안 B) 뒤: 컬러 픽셀 0 · 흑백 결과 표시', b2.colored === 0 && /변환 결과 표시/.test(b2.verdict), b2);
    pvvToggleBw(); await sleep(100);
    const c = await view();
    ck('다시 B로 해제: 컬러로 돌아옴', c.colored > 1000 && !/변환 결과 표시/.test(c.verdict), c);
    // 메인에서 지정 → 적용(확정) → 크게 보기
    closePageView();
    selectedPages.clear(); selectedPages.add(1); updateSelectedCount();
    await applyChanges(); for (let i = 0; i < 300 && (applying || !processedPdfBytes); i++) await sleep(100);
    pvvOpen(0); await sleep(200);
    const e2 = await view();
    ck('적용 후 크게 보기: 흑백', e2.colored === 0, e2);
    pvvNav(1); await sleep(100);
    const f = await view();
    ck('지정 안 한 2쪽은 컬러 그대로', f.colored > 1000, f);
    closePageView();
    ck('창 닫으면 흑백 결과 문서 해제', _pvvBwDoc.pdf === null);
    } catch (e) { out.push(['✘', '예외', String(e && e.stack || e).slice(0, 500)]); }
    return out;
  })()`);
  let fail = 0;
  out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${out.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
