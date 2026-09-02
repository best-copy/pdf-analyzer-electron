// 💼 작업 파일을 열고 아무것도 하지 않은 채 닫으면 확인 없이 바로 닫혀야 한다.
// (열자마자 도는 미리보기·적용본 복원이 '저장 안 한 작업'으로 기록되던 문제)
//   실행: npx electron scripts/test/workfile-close-clean.e2e.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfclose_'));
  let savePath = null;
  ipcMain.handle('dialog:saveFilePath', (_e, { defaultName }) => (savePath = path.join(dir, defaultName)));
  ipcMain.handle('dialog:confirmSavePath', (_e, { filePath }) => filePath);

  // main이 닫기 확인을 띄울지 판단하는 두 신호를 그대로 받는다
  let askOnClose = null, unsaved = null;
  ipcMain.on('app:docopen', (_e, open) => { askOnClose = open; });
  ipcMain.on('app:dirty', (_e, d) => { unsaved = d; });
  const wouldAsk = () => (unsaved === true) || (askOnClose === true);   // main.js의 닫기 조건과 동일

  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const out = [];
  const ck = (n, c, x) => { if (!c) out.fail = true; out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]); };

  // ① 문서를 열고 편집·적용까지 한 뒤 작업 파일로 저장
  await win.webContents.executeJavaScript(`(async () => {
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 60000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 3; i++) { const p = d.addPage([300, 420]); p.drawText('p' + i, { x: 20, y: 380, size: 14, font: f, color: rgb(0,0,0) }); }
    const b = await d.save();
    startLoad([{ name: 'wf.pdf', size: b.length, type: 'application/pdf', arrayBuffer: () => Promise.resolve(b.buffer.slice(0)) }]);
    await waitFor(() => pageResults.length === 3 && pageResults.every(r => r && r.thumbnail));
    rotatePage(0, 90);                       // 편집 하나
    await applyChanges();                    // 적용본까지 만들어 작업 파일에 담기게
    await waitFor(() => !!processedPdfBytes, 120000);
    return await saveWorkFile();
  })()`);
  await new Promise(r => setTimeout(r, 500));
  ck('저장 직후엔 묻지 않음', wouldAsk() === false, { askOnClose, unsaved });

  // ② 탭을 닫고 그 작업 파일을 다시 연다 — 아무 조작도 하지 않는다
  await win.webContents.executeJavaScript(`(async () => {
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 60000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    closeTab(activeTabId);
    await new Promise(r => setTimeout(r, 300));
    await openWorkFilePath(${JSON.stringify(savePath)});
    return await waitFor(() => pageResults.length === 3 && pageResults.every(r => r && r.thumbnail), 60000);
  })()`);
  await new Promise(r => setTimeout(r, 1500));
  ck('연 직후 묻지 않음', wouldAsk() === false, { askOnClose, unsaved });

  // 열자마자 도는 자동 갱신(미리보기·프리웜)이 끝난 뒤에도 그대로여야 한다
  await new Promise(r => setTimeout(r, 5000));
  ck('자동 갱신이 끝난 뒤에도 묻지 않음', wouldAsk() === false, { askOnClose, unsaved });
  // (적용본 복원 자체는 chapter-focus-workfile.e2e.js에서 확인한다 — 여기서는 닫기 동작만 본다)

  // ③ 사용자가 실제로 손대면 다시 물어야 한다
  await win.webContents.executeJavaScript(`(async () => {
    rotatePage(0, 90);
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 800));
  ck('편집하면 다시 묻는 대상', wouldAsk() === true, { askOnClose, unsaved });

  // ④ 다시 저장하면 또 조용해진다
  await win.webContents.executeJavaScript('saveWorkFile()');
  await new Promise(r => setTimeout(r, 6000));
  ck('다시 저장하면 묻지 않음', wouldAsk() === false, { askOnClose, unsaved });

  let fail = 0;
  out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${out.length - fail} 통과 / ${fail} 실패\n`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  app.exit(fail ? 1 : 0);
});
