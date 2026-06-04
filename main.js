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

// ── IPC: 업무관리 앱 열기 (BrowserWindow — Electron 세션 공유로 localStorage 동기화) ──
ipcMain.handle('shell:openBizApp', async () => {
  const p = 'D:\\claude\\projects\\business-mgmt\\index.html';
  if (!fs.existsSync(p)) return false;

  // 이미 열려 있으면 포커스만 이동
  const existing = BrowserWindow.getAllWindows().find(w => {
    try { return w.webContents.getURL().includes('business-mgmt'); } catch { return false; }
  });
  if (existing) { existing.focus(); return true; }

  const bizWin = new BrowserWindow({
    width: 1280, height: 900,
    title: '업무 관리 — 일청기획',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    }
  });
  bizWin.loadFile(p);
  return true;
});
