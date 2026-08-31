// 📐 좌측 '분석·처리옵션' 패널 압축 회귀 테스트 — 패널이 화면을 다 먹어 그 아래
// 페이지 썸네일이 안 보이던 문제. 실제 앱을 오프스크린으로 띄워 높이를 잰다.
//   실행: npx electron scripts/test/sidebar-compact.e2e.js
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    try { localStorage.removeItem('sbSecOpen'); } catch (e) {}
    initSbSections();   // 저장된 접힘 상태를 지우고 기본값으로 — 다른 테스트의 잔여 상태 차단
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 12; i++) { const p = d.addPage([420, 595]); p.drawText('p' + i, { x: 40, y: 500, size: 30, font: f, color: rgb(0,0,0) }); }
    const b = await d.save(); const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    startLoad([{ name: 't.pdf', size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(buf.slice(0)) }]);
    await waitFor(() => pageResults.length === 12 && pageResults.every(r => r && r.thumbnail));
    await new Promise(r => setTimeout(r, 800));
    const h = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : null; };

    // 좌측 사이드바 패널
    const sb = h('#sbPanel');
    ck('사이드바 패널 높이 ≤ 620px (이전 1332)', sb <= 620, sb);
    const firstThumb = document.querySelector('#thumbSidebar [data-sb-page]');
    const top = firstThumb ? Math.round(firstThumb.getBoundingClientRect().top) : null;
    ck('패널 아래 썸네일이 화면 안에 보임', top != null && top < window.innerHeight, { top, vh: window.innerHeight });
    ck('기본 접힘 3개(폰트·E-book·작업저장)',
       document.querySelectorAll('#sbPanelBody .sbp-section.collapsed').length === 3,
       [...document.querySelectorAll('#sbPanelBody .sbp-section.collapsed')].map(e => e.dataset.sbsec));
    // 접기/펴기 동작 + 기억
    const font = document.querySelector('[data-sbsec="font"]');
    toggleSbSection(font.querySelector('.sbp-title'));
    ck('제목 클릭으로 펼침', !font.classList.contains('collapsed'));
    ck('상태가 저장됨', JSON.parse(localStorage.getItem('sbSecOpen') || '{}').font === true);
    toggleSbSection(font.querySelector('.sbp-title'));
    ck('다시 클릭하면 접힘', font.classList.contains('collapsed'));

    // 상단 스티키(처리 옵션) 패널
    const sp = h('.sticky-panel');
    ck('상단 처리옵션 패널 ≤ 160px (이전 282)', sp <= 160, sp);
    const rows = ['.sticky-panel .selection-controls', '.sticky-panel .processing-controls'].map(h);
    ck('두 줄 모두 한 줄로 들어감(줄바꿈 없음)', rows.every(v => v <= 42), rows);
    return out;
  })()`);

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
