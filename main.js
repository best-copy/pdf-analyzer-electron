const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

function createWindow() {
  const win = new BrowserWindow({
    width:  1280,
    height: 900,
    minWidth:  900,
    minHeight: 600,
    title: 'PDF 분석기 — 일청기획',
    icon: path.join(__dirname, 'src', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,   // preload에서 fs/path 등 Node.js 내장 모듈 사용 허용
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  // win.webContents.openDevTools(); // 디버그 시 주석 해제

  // ── 줌 단축키 (Ctrl++/Ctrl+-/Ctrl+0) ────────────────────────────────────
  win.webContents.on('before-input-event', (event, input) => {
    if (!input.control) return;
    const wc = win.webContents;
    if (input.type !== 'keyDown') return;

    if (input.key === '=' || input.key === '+') {
      wc.setZoomLevel(wc.getZoomLevel() + 0.5);
      event.preventDefault();
    } else if (input.key === '-') {
      wc.setZoomLevel(wc.getZoomLevel() - 0.5);
      event.preventDefault();
    } else if (input.key === '0') {
      wc.setZoomLevel(0);
      event.preventDefault();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: 파일 열기 다이얼로그 ──────────────────────────────────────────────
ipcMain.handle('dialog:openFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'PDF 파일 선택',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled || !filePaths.length) return [];
  // 경로만 반환 — 파일 내용은 preload의 readFile()로 직접 읽음
  return filePaths.map(fp => ({ path: fp, name: path.basename(fp) }));
});

// ── IPC: PDF 저장 경로만 반환 (파일 쓰기는 preload에서 fs.writeFileSync 직접 처리)
// buffer를 IPC로 전달하면 50MB+ PDF 직렬화 과정에서 데이터 손상/잘림이 발생하므로
// 경로 취득만 main에서, 실제 쓰기는 preload(sandbox:false)에서 수행
ipcMain.handle('dialog:saveFilePath', async (_, { defaultName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'PDF 저장',
    defaultPath: defaultName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  return filePath;
});

// ── IPC: 견적서 HTML → PDF 변환 (숨겨진 BrowserWindow + printToPDF) ──────────
// Electron 26+ 에서 margins 단위가 인치로 변경됨 → marginType:'none' 사용 (HTML body padding으로 여백 처리)
// loadURL 완료를 did-finish-load 이벤트로 명시적 대기
ipcMain.handle('print:toPDF', async (_, html) => {
  const tmp = require('os').tmpdir();
  const tmpFile = path.join(tmp, `quote_${Date.now()}.html`);
  fs.writeFileSync(tmpFile, html, 'utf8');

  const hiddenWin = new BrowserWindow({
    show: false,
    width: 1024, height: 768,
    webPreferences: { contextIsolation: true, sandbox: true },
  });

  await new Promise((resolve, reject) => {
    hiddenWin.webContents.once('did-finish-load', resolve);
    hiddenWin.webContents.once('did-fail-load', (_, code, desc) =>
      reject(new Error(`페이지 로드 실패: ${desc} (${code})`))
    );
    hiddenWin.loadURL('file:///' + tmpFile.replace(/\\/g, '/'));
  });

  let pdfBuffer;
  try {
    pdfBuffer = await hiddenWin.webContents.printToPDF({
      pageSize: 'A4',
      margins: { marginType: 'none' },
      printBackground: true,
    });
  } finally {
    hiddenWin.destroy();
    try { fs.unlinkSync(tmpFile); } catch(e) {}
  }
  return pdfBuffer;
});
