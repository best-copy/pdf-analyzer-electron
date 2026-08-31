// 📄 챕터(파일)별 편집 E2E — 챕터 제목의 '✏ 편집' 버튼·우클릭 메뉴가 그 챕터만
// 편집 범위로 잡는지 실제 앱에서 확인한다.
//   실행: npx electron scripts/test/chapter-edit.e2e.js
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
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const mk = async (name, n) => {
      const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= n; i++) { const p = d.addPage([420, 595]); p.drawText('p' + i, { x: 40, y: 500, size: 28, font: f, color: rgb(0,0,0) }); }
      const b = await d.save(); const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      return { name: name + '.pdf', size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(buf.slice(0)) };
    };
    await openMergedAsChapters([await mk('A', 4), await mk('B', 3), await mk('C', 2)]);
    ck('합본 9쪽', await waitFor(() => pageResults.length === 9 && pageResults.every(r => r && r.thumbnail)), pageResults.length);
    await new Promise(r => setTimeout(r, 700));

    // 그리드 챕터 헤더에 ✏ 편집 버튼이 챕터마다 하나씩
    const editBtns = document.querySelectorAll('#pagesGrid .chapter-divider .ch-edit');
    ck('챕터 헤더마다 ✏ 편집 버튼', editBtns.length === 3, editBtns.length);
    ck('사이드바 챕터에도 ✏ 버튼', document.querySelectorAll('#thumbSidebar .sb-chapter .sb-ch-edit').length === 3);

    // ✏ 편집 클릭 → 편집 모드 + 범위=그 챕터
    editBtns[1].click();
    await new Promise(r => setTimeout(r, 500));
    ck('편집 모드 진입', document.body.classList.contains('edit-fullscreen'));
    ck('적용 범위 = 챕터', editSettings.scope.mode === 'chapter', editSettings.scope.mode);
    ck('선택된 챕터 = B.pdf', editSettings.scope.chapter === 'B.pdf', editSettings.scope.chapter);
    ck('챕터 드롭다운도 같은 값', document.getElementById('esChapterSel').value === 'B.pdf');
    // 이 챕터에만 적용되는 마스크(3쪽)
    const mask = computeScopeMask();
    ck('편집 범위가 그 챕터 3쪽', mask.filter(Boolean).length === 3, mask);
    ck('범위가 5~7쪽(B 구간)', mask.slice(4, 7).every(Boolean) && !mask[3] && !mask[7], mask);

    // 다른 챕터로 전환
    exitEditWorkspace(false);
    await new Promise(r => setTimeout(r, 300));
    editChapter('C.pdf');
    await new Promise(r => setTimeout(r, 400));
    ck('다른 챕터로 전환됨', editSettings.scope.chapter === 'C.pdf' && computeScopeMask().filter(Boolean).length === 2);
    exitEditWorkspace(false);
    await new Promise(r => setTimeout(r, 300));

    // 우클릭 메뉴
    const div0 = document.querySelector('#pagesGrid .chapter-divider');
    div0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
    const menu = document.querySelector('.ch-menu');
    ck('우클릭 메뉴 열림', !!menu);
    const labels = menu ? [...menu.querySelectorAll('.ch-menu-item span:first-child')].map(s => s.textContent) : [];
    ck('메뉴 항목 6개(편집·선택·방향·이동2·삭제)', labels.length === 6, labels);
    // '이 챕터 전체 선택'
    menu.querySelectorAll('.ch-menu-item')[1].click();
    await new Promise(r => setTimeout(r, 300));
    ck('A 챕터 4쪽 선택됨', selectedPages.size === 4, [...selectedPages]);
    ck('메뉴가 닫힘', !document.querySelector('.ch-menu'));
    return out;
  })()`);

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
