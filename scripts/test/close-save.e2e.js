// 💼 '작업 저장하고 닫기' 흐름 E2E — 닫기 요청 → 렌더러 저장 → 결과 회신까지.
//   실행: npx electron scripts/test/close-save.e2e.js
// main의 닫기 확인 다이얼로그(모달)는 자동화할 수 없으므로, 그 다이얼로그가 보내는
// 'app:saveWorkAndQuit'부터 'app:saveWorkResult' 회신까지의 실제 경로를 검증한다.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closesave_'));
  let savePath = null, sawKind = null, allowSave = false;
  // main.js의 저장 경로 다이얼로그 대역 — 실제 파일 쓰기는 preload가 한다
  ipcMain.handle('dialog:saveFilePath', (_e, { defaultName, kind }) => {
    sawKind = kind;
    if (!allowSave) return null;                 // 사용자가 저장 다이얼로그를 취소한 경우
    savePath = path.join(dir, defaultName);
    return savePath;
  });
  // 이미 경로가 정해진 작업 파일에 덮어쓰기('저장') — main의 허가 검사 대역
  ipcMain.handle('dialog:confirmSavePath', (_e, { filePath }) => (allowSave ? filePath : null));
  let lastResult = null;
  ipcMain.on('app:saveWorkResult', (_e, ok) => { lastResult = ok; });
  // main이 닫기 확인을 띄울지 판단하는 두 신호 — 렌더러가 보내는 그대로 받아 본다
  let askOnClose = null, unsaved = null;
  ipcMain.on('app:docopen', (_e, open) => { askOnClose = open; });
  ipcMain.on('app:dirty', (_e, d) => { unsaved = d; });

  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  const out = [];
  const ck = (n, c, x) => { out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]); };

  // 문서 하나 열어 저장할 작업을 만든다
  const ready = await win.webContents.executeJavaScript(`(async () => {
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { if (f()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const d = await PDFDocument.create(); const ft = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 3; i++) { const p = d.addPage([300, 420]); p.drawText('p' + i, { x: 20, y: 380, size: 12, font: ft, color: rgb(0,0,0) }); }
    const b = await d.save(); const bf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    startLoad([{ name: 'close_test.pdf', size: b.byteLength, type: 'application/pdf', arrayBuffer: () => Promise.resolve(bf.slice(0)) }]);
    return await waitFor(() => pageResults.length === 3 && pageResults.every(r => r && r.thumbnail));
  })()`);
  ck('문서 3쪽 준비', ready === true);
  await new Promise(r => setTimeout(r, 500));
  // 불러오기만 한 상태 = 아직 작업 파일로 저장한 적 없음 → 닫을 때 물어야 한다
  ck('불러오기 직후엔 닫기 질문 대상', askOnClose === true, { askOnClose, unsaved });
  ck('닫기 전 저장 요청 수신부가 있음',
     await win.webContents.executeJavaScript('typeof window.electronAPI.onSaveWorkAndQuit === "function"'));

  // ① 저장 다이얼로그를 취소하면 → false 회신(창을 닫지 않는다)
  lastResult = null; allowSave = false;
  win.webContents.send('app:saveWorkAndQuit');
  // 분석 캐시(썸네일 재인코딩)까지 굽느라 첫 저장은 몇 초 걸린다 — 넉넉히 기다린다
  await new Promise(r => setTimeout(r, 8000));
  ck('저장 취소 시 false 회신(창 유지)', lastResult === false, lastResult);
  ck("작업 파일 종류로 저장 요청('pdfw')", sawKind === 'pdfw', sawKind);

  // ② 저장하면 → true 회신 + 파일 생성
  lastResult = null; allowSave = true; savePath = null;
  win.webContents.send('app:saveWorkAndQuit');
  await new Promise(r => setTimeout(r, 6000));
  ck('저장 성공 시 true 회신(창 닫힘)', lastResult === true, lastResult);
  ck('.pdfw 파일이 만들어짐', !!savePath && fs.existsSync(savePath) && fs.statSync(savePath).size > 1000,
     savePath && fs.existsSync(savePath) ? fs.statSync(savePath).size : null);
  ck('파일명이 원본 이름 기준', !!savePath && /close_test\.pdfw$/.test(savePath), savePath && path.basename(savePath));
  // 저장된 작업 파일이 실제로 우리 형식인지(매직)
  if (savePath && fs.existsSync(savePath)) {
    const head = fs.readFileSync(savePath).slice(0, 13).toString('latin1');
    ck('작업 파일 매직 확인', head === 'PDFEDITWORK1\n', head);
  }

  // ③ 저장한 뒤에는 닫아도 묻지 않는다 (저장했는데 또 묻던 문제)
  ck('저장 후엔 닫기 질문 없음', askOnClose === false, { askOnClose, unsaved });
  ck('저장 후 저장 안 한 작업 표시도 해제', unsaved !== true, unsaved);

  // ④ 저장 뒤에 무언가 바꾸면 다시 물어야 한다
  await win.webContents.executeJavaScript('rotatePage(0, 90)');
  await new Promise(r => setTimeout(r, 600));
  ck('저장 후 편집하면 다시 닫기 질문 대상', askOnClose === true, { askOnClose, unsaved });

  // ⑤ 사이드바 '💼 작업 저장'(같은 경로)으로 다시 저장하면 또 조용해진다
  await win.webContents.executeJavaScript('saveWorkFile()');
  await new Promise(r => setTimeout(r, 8000));
  ck('다시 저장하면 닫기 질문 없음', askOnClose === false, { askOnClose, unsaved });

  let fail = 0;
  out.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${out.length - fail} 통과 / ${fail} 실패\n`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  app.exit(fail ? 1 : 0);
});
