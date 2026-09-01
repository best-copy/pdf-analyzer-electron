// 💼 작업 파일 + 📄 챕터 집중 — 챕터를 편집하던 중 저장한 작업 파일을 다시 열었을 때
// ✏ 편집이 문서 전체로 열리고(지난번 챕터에 갇히지 않고), 챕터별 설정은 그대로 적용되는지.
//   실행: npx electron scripts/test/chapter-focus-workfile.e2e.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chwf_'));
  let savePath = null;
  ipcMain.handle('dialog:saveFilePath', (_e, { defaultName }) => (savePath = path.join(dir, defaultName)));
  ipcMain.handle('dialog:confirmSavePath', (_e, { filePath }) => filePath);

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

    await openMergedAsChapters([await mk('A', 4), await mk('B', 3), await mk('C', 2)]);
    await waitFor(() => pageResults.length === 9 && pageResults.every(r => r && r.thumbnail));
    await new Promise(r => setTimeout(r, 700));

    // B 챕터만 편집(A4) 후 그 상태로 작업 저장
    editChapter('B.pdf');
    await waitFor(() => document.body.classList.contains('edit-fullscreen'));
    setScaleMode('standard');
    const psel = document.getElementById('esPaperSel'); psel.value = 'A4'; psel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 1200));
    ck('저장 전 B 챕터 집중', wsFocusChapter() === 'B.pdf' && cells().length === 3, cells().length);
    exitEditWorkspace(false);
    await new Promise(r => setTimeout(r, 400));
    const saved = await saveWorkFile();
    ck('작업 저장 성공', saved === true);

    return out;
  })()`);

  const out = res.slice();
  const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
  ck('.pdfw 파일 생성', !!savePath && fs.existsSync(savePath));

  const res2 = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const { PDFDocument } = PDFLib;
    const cells = () => document.querySelectorAll('#previewGrid .pv-cell');

    closeTab(activeTabId);
    await new Promise(r => setTimeout(r, 300));
    const ok = await openWorkFilePath(${JSON.stringify(savePath)});
    ck('작업 파일 다시 열기', ok === true);
    await waitFor(() => pageResults.length === 9 && pageResults.every(r => r && r.thumbnail), 60000);
    await new Promise(r => setTimeout(r, 800));

    ck('적용 범위가 전체로 복원', editSettings.scope.mode === 'all', editSettings.scope);
    ck('챕터별 설정(B)은 그대로 남음',
       !!(editSettings.byChapter && editSettings.byChapter['B.pdf']
          && editSettings.byChapter['B.pdf'].scaling.mode === 'standard'),
       editSettings.byChapter && Object.keys(editSettings.byChapter));

    // ✏ 편집(E) — 문서 전체가 열려야 한다 (지난번 챕터에 갇히지 않음)
    toggleEditSidebar(true);
    await waitFor(() => document.body.classList.contains('edit-fullscreen'));
    await new Promise(r => setTimeout(r, 1500));
    ck('편집이 문서 전체로 열림', cells().length === 9, cells().length);
    ck('챕터 집중 아님', wsFocusChapter() === '', wsFocusChapter());

    // 적용 결과는 예전과 동일 — B 챕터만 A4
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 60000);
    const doc = await PDFDocument.load(processedPdfBytes.slice(0));
    const sizes = doc.getPages().map(p => Math.round(p.getWidth()) + 'x' + Math.round(p.getHeight()));
    ck('B 챕터(5~7쪽)만 A4 — 챕터별 설정 유지', sizes.slice(4, 7).every(s => s === '595x842')
       && sizes.filter((s, i) => i < 4 || i > 6).every(s => s === '420x595'), sizes);

    // 그 챕터의 ✏ 편집을 다시 누르면 여전히 집중된다
    exitEditWorkspace(false);
    await new Promise(r => setTimeout(r, 300));
    editChapter('B.pdf');
    await waitFor(() => document.body.classList.contains('edit-fullscreen'));
    await new Promise(r => setTimeout(r, 1200));
    ck('✏ 편집을 누르면 다시 그 챕터만', cells().length === 3, cells().length);

    // ── 📖 챕터별 임포징 상태로 저장 → 다시 열기 ────────────────────────────
    // (예전엔 다시 열면 그 챕터의 대수만 잠깐 보였다가 전체 임포징으로 바뀌었다)
    setImpMode('booklet');
    document.getElementById('impPerChapter').checked = true;
    toggleImpEnabled(true, true);
    await new Promise(r => setTimeout(r, 2500));
    await applyChanges();
    await waitFor(() => !!processedPdfBytes, 120000);
    const impDoc = await PDFDocument.load(processedPdfBytes.slice(0));
    const impSheets = impDoc.getPageCount();
    ck('챕터별 임포징 적용됨(시트 여러 장)', impSheets >= 3, impSheets);
    ck('구간이 챕터 3개 모두', (impChapterRanges() || []).length === 3, impChapterRanges());
    exitEditWorkspace(false);
    await new Promise(r => setTimeout(r, 500));
    window.__impSheets = impSheets;
    const saved2 = await saveWorkFile();
    ck('임포징 상태로 작업 저장', saved2 === true);
    return out;
  })()`);

  const res3 = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const { PDFDocument } = PDFLib;
    const want = window.__impSheets;
    closeTab(activeTabId);
    await new Promise(r => setTimeout(r, 300));
    const ok = await openWorkFilePath(${JSON.stringify(savePath)});
    ck('임포징 작업 파일 다시 열기', ok === true);
    await waitFor(() => pageResults.length === 9 && pageResults.every(r => r && r.thumbnail), 60000);
    await new Promise(r => setTimeout(r, 1500));
    const d1 = processedPdfBytes ? (await PDFDocument.load(processedPdfBytes.slice(0))).getPageCount() : -1;
    ck('열자마자 저장된 임포징 결과 그대로', d1 === want, { d1, want });
    // 잠시 뒤에도 다른 결과로 바뀌지 않아야 한다
    await new Promise(r => setTimeout(r, 4000));
    const d2 = processedPdfBytes ? (await PDFDocument.load(processedPdfBytes.slice(0))).getPageCount() : -1;
    ck('잠시 뒤에도 같은 결과(전체가 다시 임포징되지 않음)', d2 === want, { d2, want });
    return out;
  })()`);

  const all = out.concat(res2, res3);
  let fail = 0;
  all.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${all.length - fail} 통과 / ${fail} 실패\n`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  app.exit(fail ? 1 : 0);
});
