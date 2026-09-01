// 📄 챕터 집중 E2E — 챕터의 '✏ 편집'으로 들어가면 편집 모드 화면에 그 챕터의 쪽만 보이고,
// 설정도 그 챕터에만 적용되며, 적용 결과 PDF에는 전체 문서가 그대로 남는지 확인한다.
//   실행: npx electron scripts/test/chapter-focus.e2e.js
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
      for (let i = 1; i <= n; i++) { const p = d.addPage([420, 595]); p.drawText(name + i, { x: 40, y: 500, size: 28, font: f, color: rgb(0,0,0) }); }
      const b = await d.save(); const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      return { name: name + '.pdf', size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(buf.slice(0)) };
    };
    const cells = () => document.querySelectorAll('#previewGrid .pv-cell');
    const cellNums = () => [...document.querySelectorAll('#previewGrid .pv-cell .pv-num')].map(e => e.textContent);

    // ── 작은 문서(9쪽): 전체 렌더 경로 ──────────────────────────────────────
    await openMergedAsChapters([await mk('A', 4), await mk('B', 3), await mk('C', 2)]);
    await waitFor(() => pageResults.length === 9 && pageResults.every(r => r && r.thumbnail));
    await new Promise(r => setTimeout(r, 700));

    // ① 아직 아무 편집도 없는 상태(원본 바이트를 그대로 띄우는 미리보기)에서도 좁혀져야 한다
    editChapter('B.pdf');
    await waitFor(() => document.body.classList.contains('edit-fullscreen'));
    await new Promise(r => setTimeout(r, 900));
    ck('편집 전에도 B 챕터 3쪽만 표시', cells().length === 3, cellNums());
    ck('집중 챕터 = B.pdf', wsFocusChapter() === 'B.pdf', wsFocusChapter());
    ck('편집 화면에 B 챕터 3쪽만 표시', cells().length === 3, cellNums());
    ck('표시된 쪽번호가 5~7', cellNums().join(',') === '5,6,7', cellNums());

    // 그 챕터에만 적용되는지 — A4 규격 맞춤
    setScaleMode('standard');
    const psel = document.getElementById('esPaperSel'); psel.value = 'A4'; psel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1200));
    const groups = computeLayoutGroups();
    ck('레이아웃 그룹 1개(B 챕터만)', groups.length === 1 && groups[0].mask.map(b => b?1:0).join('') === '000011100',
       groups.map(g => g.mask.map(b => b?1:0).join('')));
    ck('편집 후에도 B 3쪽만 표시', cells().length === 3, cellNums());

    // 적용 결과에는 전체 9쪽이 그대로 (다른 챕터는 원본 크기 유지)
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 60000);
    const doc = await PDFDocument.load(processedPdfBytes.slice(0));
    const sizes = doc.getPages().map(p => Math.round(p.getWidth()) + 'x' + Math.round(p.getHeight()));
    ck('적용 결과는 전체 9쪽', sizes.length === 9, sizes.length);
    ck('B 챕터(5~7쪽)만 A4', sizes.slice(4, 7).every(s => s === '595x842'), sizes);
    ck('나머지 챕터는 원본 크기', sizes.filter((s, i) => i < 4 || i > 6).every(s => s === '420x595'), sizes);

    // 적용 범위를 '전체'로 되돌리면 다시 전 쪽이 보인다
    exitEditWorkspace(false);
    await new Promise(r => setTimeout(r, 300));
    toggleEditSidebar(true);
    await new Promise(r => setTimeout(r, 400));
    setEditScope('all');
    await new Promise(r => setTimeout(r, 1200));
    ck('전체 범위로 되돌리면 9쪽 표시', cells().length === 9, cellNums());
    exitEditWorkspace(false);
    await new Promise(r => setTimeout(r, 400));

    // ── 빈 페이지를 넣어 '쪽 수 ≠ 원본 쪽 수'가 된 문서 ─────────────────────
    // (예전 작업 파일에서 실제로 이 상태였고, 원본 바이트 화면이 전혀 좁혀지지 않았다)
    insertBlankPage(0);
    await new Promise(r => setTimeout(r, 600));
    ck('빈 페이지 삽입으로 10쪽', pageResults.filter(Boolean).length === 10, pageResults.filter(Boolean).length);
    editChapter('C.pdf');
    await waitFor(() => document.body.classList.contains('edit-fullscreen'));
    await new Promise(r => setTimeout(r, 1200));
    ck('쪽 수가 달라도 C 챕터 2쪽만 표시', cells().length === 2, cellNums());
    ck('셀 번호가 문서 쪽번호(9,10)', cellNums().join(',') === '9,10', cellNums());
    exitEditWorkspace(false);
    await new Promise(r => setTimeout(r, 400));

    // ── 큰 문서(30쪽): 표본 미리보기 경로 ───────────────────────────────────
    closeTab(activeTabId);
    await new Promise(r => setTimeout(r, 300));
    await openMergedAsChapters([await mk('X', 24), await mk('Y', 6)]);
    await waitFor(() => pageResults.length === 30 && pageResults.every(r => r && r.thumbnail), 60000);
    await new Promise(r => setTimeout(r, 700));
    editChapter('Y.pdf');
    await waitFor(() => document.body.classList.contains('edit-fullscreen'));
    setScaleMode('standard');
    const psel2 = document.getElementById('esPaperSel'); psel2.value = 'A4'; psel2.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 2000));
    ck('표본 경로 진입', document.getElementById('previewGrid').dataset.wsSample === '1',
       document.getElementById('previewGrid').dataset.wsSample);
    ck('표본 그리드도 Y 챕터 6쪽만', cells().length === 6, cellNums());
    ck('표시된 쪽번호가 25~30', cellNums().join(',') === '25,26,27,28,29,30', cellNums());
    exitEditWorkspace(false);
    return out;
  })()`);

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
