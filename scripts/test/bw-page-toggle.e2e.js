// 쪽 단위 흑백↔컬러 — 우클릭 '흑백'(B)·'컬러'(C), '원본 페이지 보기' 표시 (app-core setPageBw · syncBwAppliedTag)
//   실행: npx electron scripts/test/bw-page-toggle.e2e.js
// 사용자 지적(2026-10-07, 테스트1007.pdfw):
//   · 크게 보기가 흑백으로 '되었다 안되었다' — 우클릭 '흑백'은 선택만 해서 ⬛ 흑백변환이 꺼져 있으면 컬러 그대로(메뉴엔 ✓ 흑백)
//   · 흑백 적용 후 '원본 페이지 보기'에서 썸네일만 회색(선택 때 건 필터가 남음)·라벨은 컬러, ⬛ 흑백변환을 한 번 더 눌러야 원래대로
// 결정: '원본 페이지 보기'는 원본 그대로 + '흑백 적용' 표식. '흑백'은 흑백변환까지 켜고, '컬러'는 확정된 쪽도 그 쪽만 되돌린다.
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-bwtoggle-e2e'));
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
    const d = await PDFLib.PDFDocument.create(); const { rgb } = PDFLib;
    for (let k = 0; k < 4; k++) { const p = d.addPage([300, 400]); p.drawRectangle({ x: 30, y: 60, width: 240, height: 280, color: rgb(0.85, 0.25 + k * 0.1, 0.1) }); }
    const b = await d.save();
    startLoad([{ name: 'bwtoggle.pdf', size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.slice(0).buffer) }]);
    for (let i = 0; i < 300 && !(pageResults.length === 4 && pageResults.every(r => r && r.thumbnail) && isTabReady(tabs.get(activeTabId))); i++) await sleep(100);
    const item = pn => document.querySelector('#pagesGrid .page-item[data-page="' + pn + '"]');
    const thumb = pn => { const el = item(pn); const img = el.querySelector('.page-thumbnail');
      return { gray: !!(img && img.style.filter), label: el.querySelector('.page-type-inline').textContent, tag: !!el.querySelector('.page-bw-tag') }; };
    const ctx = (pn, which) => {   // 우클릭 → '흑백' 또는 '컬러 (흑백 선택 해제)'
      const el = item(pn) || document.querySelector('#thumbSidebar [data-sb-page="' + pn + '"]'); const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));
      const chk = document.getElementById(which === 'bw' ? 'ctxChk_bw' : 'ctxChk_color');
      const st = { bw: document.getElementById('ctxChk_bw').classList.contains('on'), color: document.getElementById('ctxChk_color').classList.contains('on') };
      chk.closest('.ctx-item').click();
      return st;
    };
    const view = async (idx) => { closePageView(); pvvOpen(idx); _pvvBase = null; await sleep(20);
      for (let i = 0; i < 400 && !_pvvBase; i++) await sleep(25); await sleep(80);
      const m = document.getElementById('pvvStat').textContent.match(/컬러 픽셀 ([\\d,]+)개/); closePageView(); return m ? +m[1].replace(/,/g, '') : 0; };
    const waitApplied = async () => { for (let i = 0; i < 600 && (applying || !processedPdfBytes); i++) await sleep(50); await sleep(300); };

    // 1) 흑백변환 꺼진 채 우클릭 '흑백' → 흑백변환이 켜지고 그 쪽이 흑백 대상
    ck('전제: 흑백변환 꺼짐', !processingOptions.bw);
    const m0 = ctx(2, 'bw'); await sleep(100);
    ck('우클릭 흑백 전 메뉴 ✓는 컬러', m0.color && !m0.bw, m0);
    ck('흑백변환이 켜지고 2쪽이 흑백 대상', processingOptions.bw && isBwTarget(pageResults[1]), { bw: processingOptions.bw });
    ck('2쪽 썸네일 회색 미리보기·라벨 흑백', thumb(2).gray && thumb(2).label === '흑백', thumb(2));
    ck('크게 보기: 2쪽 흑백', (await view(1)) === 0);
    ctx(3, 'bw'); await sleep(100);

    // 2) 적용 → 결과 화면 → 원본 페이지 보기: 원본 썸네일 + '흑백 적용' 표식
    await applyChanges(); await waitApplied();
    ck('적용 뒤 2·3쪽 확정', !!(pageResults[1].appliedBw && pageResults[2].appliedBw));
    closePreview(); await sleep(300);
    const t2 = thumb(2), t4 = thumb(4);
    ck('원본 페이지 보기: 2쪽 썸네일 원본(회색 아님)·라벨 원래대로·표식 있음', !t2.gray && /컬러/.test(t2.label) && t2.tag, t2);
    ck('흑백 안 한 4쪽은 표식 없음', !t4.gray && !t4.tag, t4);
    const sb = [...document.querySelectorAll('#thumbSidebar .sb-item')];
    ck('왼쪽 썸네일: 회색 없음 · 2·3쪽에 흑 표식', !sb.some(e => e.querySelector('img') && e.querySelector('img').style.filter) && document.querySelectorAll('#thumbSidebar .page-bw-tag').length === 2);
    ck('크게 보기: 확정된 2쪽은 흑백(변환 결과)', (await view(1)) === 0);
    const m1 = ctx(2, 'color'); await sleep(150);   // 3) 확정된 2쪽만 컬러로

    // 3) 우클릭 '컬러' — 확정된 쪽도 그 쪽만 되돌린다
    ck('컬러 누르기 전 메뉴 ✓는 흑백', m1.bw && !m1.color, m1);
    ck('2쪽 확정 해제 · 3쪽은 그대로', !pageResults[1].appliedBw && !!pageResults[2].appliedBw && !isBwTarget(pageResults[1]));
    ck('2쪽 표식 사라짐(메인·왼쪽)', !thumb(2).tag && !document.querySelector('#thumbSidebar [data-sb-page="2"] .page-bw-tag'));
    ck('크게 보기: 2쪽 컬러', (await view(1)) > 1000);
    await applyChanges(); await waitApplied();
    const pd = await PDFLib.PDFDocument.load(processedPdfBytes.slice(0));
    const neu = pd.getPages().map(p => pageIsNeutral(pd, p.node) ? 'K' : 'C').join('');
    ck('다시 적용한 결과: 2쪽 컬러 · 3쪽 흑백', neu === 'CCKC', neu);
    // 4) 흑백변환 끄기 — 표식 전부 사라짐
    closePreview(); await sleep(200);
    toggleOption('bw'); await sleep(300);
    ck('흑백변환 끄면 확정·표식 모두 해제', !pageResults.some(r => r.appliedBw) && !document.querySelector('.page-bw-tag'));
    } catch (e) { out.push(['✘', '예외', String(e && e.stack || e).slice(0, 500)]); }
    return out;
  })()`);
  let fail = 0;
  out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${out.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
