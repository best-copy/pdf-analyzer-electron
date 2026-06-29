const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { execFile } = require('child_process');

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
    title: '파일 선택 (PDF · HWP · HWPX · MS Office · Adobe)',
    filters: [
      { name: '문서 전체 (PDF·HWP·Office·Adobe)',
        extensions: ['pdf', 'hwp', 'hwpx', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'ai', 'psd', 'indd'] },
      { name: 'PDF',  extensions: ['pdf'] },
      { name: '한글 (HWP·HWPX)', extensions: ['hwp', 'hwpx'] },
      { name: 'Word (DOC·DOCX)', extensions: ['doc', 'docx'] },
      { name: 'Excel (XLS·XLSX)', extensions: ['xls', 'xlsx'] },
      { name: 'PowerPoint (PPT·PPTX)', extensions: ['ppt', 'pptx'] },
      { name: 'Adobe (AI·PSD·INDD)', extensions: ['ai', 'psd', 'indd'] },
    ],
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

// ── IPC: HWP/HWPX → PDF 변환 (한컴오피스 한글 COM 자동화) ────────────────────
// 한글은 단일 인스턴스로만 동작하므로 동시 변환 시 충돌 → 큐로 순차 처리.
// 변환된 임시 PDF 경로를 반환하고, 렌더러는 preload.readFile()로 직접 읽는다.
let hwpQueue = Promise.resolve();

function convertHwpToPdf(srcPath) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(
      os.tmpdir(),
      `hwpconv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.pdf`
    );
    const script = path.join(__dirname, 'src', 'convert_hwp.ps1');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
       '-InPath', srcPath, '-OutPath', outPath],
      { windowsHide: true, timeout: 180000 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').toString().trim();
          return reject(new Error('한글 문서 변환 실패: ' + (msg || '알 수 없는 오류')));
        }
        if (!fs.existsSync(outPath)) {
          return reject(new Error('한글 문서 변환 실패: PDF가 생성되지 않았습니다.'));
        }
        resolve(outPath);
      }
    );
  });
}

ipcMain.handle('hwp:convertToPdf', (_, srcPath) => {
  // 이전 변환의 성공/실패와 무관하게 다음 변환을 순차로 이어 실행
  const run = () => convertHwpToPdf(srcPath);
  const result = hwpQueue.then(run, run);
  // 큐 체인은 실패가 전파되지 않도록 별도로 유지 (반환 promise만 실제 결과)
  hwpQueue = result.catch(() => {});
  return result;
});

// ── IPC: MS Office(Word·Excel·PowerPoint) → PDF 변환 (Office COM 자동화) ──────
// 한글과 마찬가지로 동일 Office 앱은 단일 인스턴스로만 안전하므로 큐로 순차 처리.
// (Word/Excel/PowerPoint가 섞여도 하나의 큐로 직렬화하여 충돌·자원 경합을 피한다)
let officeQueue = Promise.resolve();

function convertOfficeToPdf(srcPath) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(
      os.tmpdir(),
      `officeconv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.pdf`
    );
    const script = path.join(__dirname, 'src', 'convert_office.ps1');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
       '-InPath', srcPath, '-OutPath', outPath],
      { windowsHide: true, timeout: 180000 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').toString().trim();
          return reject(new Error('Office 문서 변환 실패: ' + (msg || '알 수 없는 오류')));
        }
        if (!fs.existsSync(outPath)) {
          return reject(new Error('Office 문서 변환 실패: PDF가 생성되지 않았습니다.'));
        }
        resolve(outPath);
      }
    );
  });
}

ipcMain.handle('office:convertToPdf', (_, srcPath) => {
  const run = () => convertOfficeToPdf(srcPath);
  const result = officeQueue.then(run, run);
  officeQueue = result.catch(() => {});
  return result;
});

// ── IPC: Adobe(Photoshop·InDesign·Illustrator) → PDF 변환 (Adobe COM 자동화) ──
// 각 Adobe 앱은 단일 인스턴스로만 안전하고 첫 실행이 느리므로(수십 초) 큐로 순차 처리.
// PDF 호환 .ai는 렌더러에서 직접 처리하므로 여기로 오지 않는다(비호환 .ai만 폴백).
let adobeQueue = Promise.resolve();

function convertAdobeToPdf(srcPath) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(
      os.tmpdir(),
      `adobeconv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.pdf`
    );
    const script = path.join(__dirname, 'src', 'convert_adobe.ps1');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
       '-InPath', srcPath, '-OutPath', outPath],
      { windowsHide: true, timeout: 300000 },   // Adobe 앱 실행이 느려 5분 여유
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || '').toString().trim();
          return reject(new Error('Adobe 파일 변환 실패: ' + (msg || '알 수 없는 오류')));
        }
        if (!fs.existsSync(outPath)) {
          return reject(new Error('Adobe 파일 변환 실패: PDF가 생성되지 않았습니다.'));
        }
        resolve(outPath);
      }
    );
  });
}

ipcMain.handle('adobe:convertToPdf', (_, srcPath) => {
  const run = () => convertAdobeToPdf(srcPath);
  const result = adobeQueue.then(run, run);
  adobeQueue = result.catch(() => {});
  return result;
});
