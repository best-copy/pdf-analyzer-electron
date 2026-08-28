const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { execFile, spawn } = require('child_process');
const remoteServer = require('./remote-server');   // 모바일 연동 LAN 변환 서버
const license      = require('./license');         // 체험판 1회용 키 (저장·출력 게이트)
const licenseServer = require('./license-server'); // 활성화 서버 (관리자 PC에서만 구동)
const licenseTunnel = require('./license-tunnel'); // 외부 접속 터널 (cloudflared)

// ── 성능: GPU 가속·래스터화 활성화 (캔버스·PDF 렌더링 가속) ──────────────────
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization');

// 렌더러가 보고하는 '저장 안 한 작업' 여부 + 강제 종료 플래그
let unsavedWork = false;
let forceClose  = false;

// ── 외부 실행 인자로 받은 문서 열기 (목차 검증기 '이어서 작업' 연동) ─────────
// 실행: "PDF 분석기.exe 문서.pdf" — 시작 시 인자의 문서를 바로 연다.
// pdfw = 💼 작업 파일(원본 PDF + 작업 상태가 한 파일에) — 더블클릭하면 그 시점 그대로 열린다
const OPEN_DOC_RE = /\.(pdfw|pdf|hwpx?|docx?|xlsx?|pptx?|psd|indd|ai)$/i;

function docPathsFrom(argv) {
  return argv
    .slice(1)
    .filter((a) => a && !a.startsWith('-') && OPEN_DOC_RE.test(a) && fs.existsSync(a));
}

let pendingOpenPaths = docPathsFrom(process.argv);
let mainWin = null;   // 메인 창 (편집기 창과 구분 — 외부 문서 전달 대상)

// ── 단일 인스턴스: '보내기'·가상 프린터로 온 문서를 기존 창에 전달 ───────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const items = docPathsFrom(argv).map((p) => ({ path: p, name: path.basename(p) }));
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
      if (items.length) mainWin.webContents.send('external:open', items);
    } else if (items.length) {
      pendingOpenPaths.push(...items.map(i => i.path));
    }
    // 상주 감시자가 인쇄 감지로 앱을 재실행한 경우 — 대기 중 인쇄물 수거
    try { ingestPrintedFile(printPortFile()); } catch (e) {}
  });
}

// ── Windows '보내기' 메뉴 등록 (포터블 실행 시 자동) ────────────────────────
// 탐색기에서 문서 우클릭 → 보내기 → 'PDF 분석기' 로 바로 열기.
function ensureSendToShortcut() {
  try {
    if (!app.isPackaged) return;   // 개발 실행(electron.exe)은 등록하지 않음
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', 'PDF 분석기.lnk');
    try {
      const cur = shell.readShortcutLink(lnk);
      if (cur.target === process.execPath) return;   // 이미 최신
    } catch (e) {}
    shell.writeShortcutLink(lnk, { target: process.execPath, description: 'PDF 분석기로 열기' });
  } catch (e) { console.warn('보내기 메뉴 등록 실패:', e); }
}

// ── 💼 작업 파일(.pdfw) 더블클릭 '연결 등록' 기능은 제거했다 ────────────────
// HKCU\Software\Classes에 확장자·ProgID·open command를 다 써 넣어도, 윈도우 10/11의 탐색기는
// FileExts\.pdfw\UserChoice를 보고 여는데 그 값은 **사용자 본인만** 정할 수 있게 해시로 보호돼 있다.
// 결국 더블클릭하면 앱이 열리는 대신 '이 파일을 어떻게 열까요?' 창이 떠서, 프로그램이 완결지을 수
// 없는 기능이었다. 대신 사용자가 파일을 우클릭 → 연결 프로그램 → 이 앱을 한 번 지정하면
// 아래 인자 처리(OPEN_DOC_RE)로 그대로 열린다.

// ── 가상 프린터 'PDF Editor' — 어떤 앱에서든 인쇄로 이 앱에 문서 전달 ────────
// Microsoft Print To PDF 드라이버 + 고정 파일 포트. 포트 파일이 갱신되면
// 감시자가 임시 사본을 떠서 메인 창으로 열어준다(다음 인쇄가 덮어써도 안전).
const printDropDir = () => path.join(app.getPath('userData'), 'printjobs');
const printPortFile = () => path.join(printDropDir(), 'print_output.pdf');

// 가상 프린터 설치 여부 확인 (승격 불필요) — 설치돼 있으면 설치 버튼 숨김용
ipcMain.handle('printer:status', () => {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-Command', `(Get-Printer -Name 'PDF Editor' -ErrorAction SilentlyContinue) -ne $null`],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => resolve({ installed: String(stdout).trim() === 'True' }));
  });
});

ipcMain.handle('printer:setup', () => {
  return new Promise((resolve) => {
    try { fs.mkdirSync(printDropDir(), { recursive: true }); } catch (e) {}
    const port = printPortFile().replace(/'/g, "''");
    const ps = [
      `$ErrorActionPreference='Stop'`,
      `if (-not (Get-PrinterPort -Name '${port}' -ErrorAction SilentlyContinue)) { Add-PrinterPort -Name '${port}' }`,
      `if (-not (Get-Printer -Name 'PDF Editor' -ErrorAction SilentlyContinue)) { Add-Printer -Name 'PDF Editor' -DriverName 'Microsoft Print To PDF' -PortName '${port}' }`,
      // 인쇄 완료 로그(문서명 기록) 활성화 — 접수 파일의 '원래 문서 이름' 복구용.
      // 포트가 고정 파일이라 파일명에는 문서명이 없고, 스풀러 로그에만 남는다.
      // (Windows 기본값은 꺼짐. 실패해도 프린터 설치 자체는 계속 진행 — SilentlyContinue)
      `try { wevtutil sl Microsoft-Windows-PrintService/Operational /e:true /ms:4194304 } catch {}`,
    ].join('; ');
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    // 프린터 추가는 관리자 권한 필요 → UAC 승격 실행 후, 실제 설치됐는지 재확인
    execFile('powershell.exe',
      ['-NoProfile', '-Command', `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${enc}'`],
      { windowsHide: true, timeout: 180000 },
      () => {
        execFile('powershell.exe', ['-NoProfile', '-Command', `(Get-Printer -Name 'PDF Editor' -ErrorAction SilentlyContinue) -ne $null`],
          { windowsHide: true, timeout: 20000 },
          (err2, stdout) => {
            const ok = String(stdout).trim() === 'True';
            if (ok) installPrintWatchdog();   // 설치 성공 → 상주 감시자(인쇄 시 앱 자동 실행)도 구성
            resolve({ ok });
          });
      });
  });
});

// 앱 시작 시: 앱이 꺼진 동안 인쇄된 결과물이 포트 파일에 남아 있으면 열어준다.
// (인쇄 → 앱 자동 실행 흐름의 수신부 — 실행은 아래 상주 감시자가 담당)
function ingestPendingPrintOnBoot() {
  try {
    const p = printPortFile();
    const st = fs.statSync(p);
    if (!st.size) return;
    if (Date.now() - st.mtimeMs < 2500) {
      // 방금 인쇄돼 아직 쓰는 중일 수 있음 — 창 로드 후 안정화 검사 경로로
      setTimeout(() => ingestPrintedFile(p), 3000);
      return;
    }
    const dst = path.join(os.tmpdir(), `pdfedit_print_${Date.now()}.pdf`);
    fs.copyFileSync(p, dst);
    fs.unlinkSync(p);
    // 앱이 꺼져 있는 동안 인쇄된 건 — 인쇄 로그에서 원래 문서명을 되찾는다(넉넉히 1시간 이내)
    const entry = { path: dst, name: `인쇄접수_${Date.now() % 100000}.pdf` };
    pendingOpenPaths.push(entry);   // 창 로드 완료 시 external:open으로 전달됨
    lookupPrintedDocFromLog(3600, raw => {
      const nm = cleanPrintDocName(raw);
      if (nm) entry.name = `${nm}.pdf`;   // 창 로드 전이면 이 이름으로, 늦으면 기본 이름 유지
    });
  } catch (e) {}
}

// ── 상주 인쇄 감시자 — 앱이 꺼져 있어도 인쇄가 오면 앱을 실행 ────────────────
// 로그온 시 숨김 PowerShell(FileSystemWatcher, 뮤텍스 1개 보장)이 포트 폴더를 감시.
// 앱 미실행 시에만 실행(실행 중이면 앱 내 감시자가 처리, 단일 인스턴스라 중복 없음).
function installPrintWatchdog() {
  try {
    if (!app.isPackaged) return false;   // 개발 실행은 등록하지 않음
    const dir = printDropDir();
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'print-watch.ps1');
    const exe = process.execPath;
    const procName = path.basename(exe, '.exe');
    const ps = `﻿# PDF Editor 인쇄 감시 — 인쇄 결과가 도착하면 앱을 실행한다 (자동 생성 파일)
$m = New-Object System.Threading.Mutex($false, 'PDFEditorPrintWatch')
if (-not $m.WaitOne(0)) { exit }
$dir = '${dir.replace(/'/g, "''")}'
$exe = '${exe.replace(/'/g, "''")}'
$fsw = New-Object System.IO.FileSystemWatcher $dir, '*.pdf'
$fsw.EnableRaisingEvents = $true
while ($true) {
  $r = $fsw.WaitForChanged([System.IO.WatcherChangeTypes]'Created, Changed', 15000)
  if (-not $r.TimedOut) {
    Start-Sleep -Milliseconds 2000
    if (-not (Get-Process -Name '${procName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue)) {
      Start-Process -FilePath $exe
    }
  }
}`;
    fs.writeFileSync(script, ps, 'utf8');
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
    // 로그온 자동 시작 (HKCU — 관리자 불필요) + 지금 즉시 1개 기동
    execFile('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v', 'PDFEditorPrintWatch', '/t', 'REG_SZ', '/d', cmd, '/f'], { windowsHide: true }, () => {});
    // 즉시 기동 — WMI(Win32_Process.Create)로 띄워 앱과 완전히 분리된 프로세스로 만든다.
    // (spawn detached는 Electron 종료 시 함께 죽는 문제가 있었음 — 실측 확인)
    const escaped = script.replace(/'/g, "''");
    execFile('powershell.exe', ['-NoProfile', '-Command',
      `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${escaped}"' } | Out-Null`],
      { windowsHide: true, timeout: 20000 }, () => {});
    return true;
  } catch (e) { console.warn('인쇄 감시자 설치 실패:', e); return false; }
}
// 프린터가 설치돼 있으면 감시자 구성을 자동 복구(멱등) — 이전 버전 설치 사용자 대응
function repairPrintWatchdogIfNeeded() {
  if (!app.isPackaged) return;
  execFile('powershell.exe',
    ['-NoProfile', '-Command', `(Get-Printer -Name 'PDF Editor' -ErrorAction SilentlyContinue) -ne $null`],
    { windowsHide: true, timeout: 20000 },
    (err, stdout) => { if (String(stdout).trim() === 'True') installPrintWatchdog(); });
}

// ── 접수 문서의 '원래 이름' 복구 ─────────────────────────────────────────────
// 포트가 고정 파일(print_output.pdf)이라 파일명에는 문서명이 없다. 문서명은 스풀러에만
// 있으므로 두 경로로 회수한다:
//   ① 인쇄 완료 로그(PrintService/Operational 이벤트 307) — 앱이 꺼져 있을 때 인쇄된 것도 복구
//   ② 인쇄 작업 큐(Win32_PrintJob) 실시간 캡처 — 로그를 못 켠 환경(UAC 거부·정책)용 폴백
// 둘 다 실패하면 기존처럼 '인쇄접수_시각'을 쓴다.
const PRINT_LOG = 'Microsoft-Windows-PrintService/Operational';
let _printLogEnabled = false;
let _lastPrintJob = null;      // { name, at } — 실시간 캡처 결과
let _printJobPoller = null;

// PowerShell 출력의 한글 깨짐(콘솔 코드페이지) 회피 — base64(UTF-8)로 주고받는다
function psB64(script, cb, timeout) {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: timeout || 15000 },
    (err, stdout) => {
      // PowerShell은 조회 도중 비종료 오류만 있어도 종료코드 1을 내므로(로그 비활성 등)
      // 종료코드가 아니라 '출력이 있는지'로 판단한다.
      const b64 = String(stdout || '').trim();
      if (!b64) return cb(null);
      try { cb(Buffer.from(b64, 'base64').toString('utf8').trim() || null); }
      catch (e) { cb(null); }
    });
}

// 인쇄 문서명 정리 — 앱이 붙이는 접두·접미와 경로·확장자를 떼고 파일명으로 안전하게.
// 예) 'Microsoft Word - 계약서.docx' → '계약서', '견적서.xlsx - Excel' → '견적서'
function cleanPrintDocName(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s || /^(문서|document)$/i.test(s)) return '';
  s = s.replace(/^(Microsoft\s+(Word|Excel|PowerPoint|Edge)|Adobe\s+\w+|메모장|Notepad|Chrome|Firefox)\s+[-–]\s+/i, '');
  s = s.replace(/\s+[-–]\s+(Microsoft\s+)?(Word|Excel|PowerPoint|Edge|Chrome|Firefox|한글|Adobe\s+\w+)\s*$/i, '');
  // 경로가 통째로 온 경우만 앞부분 제거 — 제목에 그냥 '/'가 들어간 경우(제품/사양)는 보존
  if (/^[a-z]:[\\/]|^\\\\|^https?:\/\/|\\/i.test(s)) s = s.replace(/^.*[\\/]/, '');
  s = s.replace(/\.(pdf|hwpx?|docx?|xlsx?|pptx?|txt|jpe?g|png|html?)$/i, '');
  s = s.replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 80);
}

// ① 인쇄 로그에서 최근(초 단위 window) 'PDF Editor' 인쇄 작업의 문서명 조회
// (로그가 꺼져 있으면 조회 결과가 비어 자연히 null — 활성 여부 확인을 기다리지 않는다)
function lookupPrintedDocFromLog(withinSec, cb) {
  const script = `$ErrorActionPreference='SilentlyContinue'
$evs = Get-WinEvent -FilterHashtable @{LogName='${PRINT_LOG}';Id=307;StartTime=(Get-Date).AddSeconds(-${withinSec | 0})} -MaxEvents 25
foreach ($e in $evs) {
  $x = [xml]$e.ToXml(); $d = $x.Event.UserData.FirstChild
  if ($d -and $d.Param5 -eq 'PDF Editor' -and $d.Param2) {
    [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$d.Param2)); break
  }
}
exit 0`;
  psB64(script, cb);
}

// ② 인쇄 작업 큐 실시간 캡처 — 로그를 못 쓰는 환경에서만 상주(문서명이 보이면 기록)
function startPrintJobPoller() {
  if (_printJobPoller) return;
  const script = `$ErrorActionPreference='SilentlyContinue'
while ($true) {
  $j = Get-CimInstance Win32_PrintJob | Where-Object { $_.Name -like 'PDF Editor,*' } | Select-Object -First 1
  if ($j -and $j.Document) {
    [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$j.Document))
  }
  Start-Sleep -Milliseconds 700
}`;
  try {
    _printJobPoller = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    _printJobPoller.stdout.on('data', buf => {
      String(buf).split(/\r?\n/).forEach(line => {
        const b64 = line.trim();
        if (!b64) return;
        try {
          const name = cleanPrintDocName(Buffer.from(b64, 'base64').toString('utf8'));
          if (name) _lastPrintJob = { name, at: Date.now() };
        } catch (e) {}
      });
    });
    _printJobPoller.on('exit', () => { _printJobPoller = null; });
  } catch (e) { console.warn('인쇄 작업 감시 실패:', e); }
}
function stopPrintJobPoller() {
  if (!_printJobPoller) return;
  try { _printJobPoller.kill(); } catch (e) {}
  _printJobPoller = null;
}

// 프린터가 설치돼 있으면 로그 사용 가능 여부를 확인하고, 불가하면 실시간 캡처로 폴백
function initPrintDocNameSources() {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='SilentlyContinue'; if (Get-Printer -Name 'PDF Editor') { (Get-WinEvent -ListLog '${PRINT_LOG}').IsEnabled } else { 'noprinter' }`],
    { windowsHide: true, timeout: 20000 },
    (err, stdout) => {
      const out = String(stdout || '').trim();
      if (out === 'noprinter' || err) return;      // 가상 프린터 미설치 — 아무것도 상주시키지 않음
      _printLogEnabled = out === 'True';
      if (!_printLogEnabled) startPrintJobPoller();   // 로그가 꺼져 있을 때만 폴링 상주
    });
}

// 접수 파일에 붙일 이름 결정 (실시간 캡처 우선 → 로그 → 폴백)
function resolvePrintedDocName(cb) {
  const fresh = _lastPrintJob && (Date.now() - _lastPrintJob.at < 180000) ? _lastPrintJob.name : null;
  if (fresh) { _lastPrintJob = null; return cb(fresh); }
  lookupPrintedDocFromLog(180, raw => cb(cleanPrintDocName(raw) || null));
}

let _printDebounce = null;
function startPrintWatcher() {
  try {
    fs.mkdirSync(printDropDir(), { recursive: true });
    fs.watch(printDropDir(), (_ev, fn) => {
      if (!fn || !/\.pdf$/i.test(fn)) return;
      clearTimeout(_printDebounce);
      _printDebounce = setTimeout(() => ingestPrintedFile(path.join(printDropDir(), fn)), 900);
    });
  } catch (e) { console.warn('인쇄 감시 시작 실패:', e); }
}
function ingestPrintedFile(p, retry) {
  fs.stat(p, (e, st1) => {
    if (e || !st1.size) return;
    setTimeout(() => fs.stat(p, (e2, st2) => {
      if (e2) return;
      if (st2.size !== st1.size) {   // 아직 쓰는 중 — 재시도 (최대 20회)
        if ((retry || 0) < 20) setTimeout(() => ingestPrintedFile(p, (retry || 0) + 1), 700);
        return;
      }
      const dst = path.join(os.tmpdir(), `pdfedit_print_${Date.now()}.pdf`);
      try { fs.copyFileSync(p, dst); } catch (err) { return; }
      try { fs.unlinkSync(p); } catch (err) {}   // 처리 완료 — 재기동 시 중복 열림 방지
      // 인쇄를 건 문서의 원래 이름을 찾아 붙인다(못 찾으면 기존처럼 '인쇄접수_시각')
      resolvePrintedDocName(docName => {
        const name = `${docName || `인쇄접수_${Date.now() % 100000}`}.pdf`;
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send('external:open', [{ path: dst, name }]);
          if (mainWin.isMinimized()) mainWin.restore();
          mainWin.focus();
        } else {
          pendingOpenPaths.push({ path: dst, name });   // 창 로드 시 이 이름으로 열림
        }
      });
    }), 600);
  });
}

// 이전 세션에서 남은 변환 임시 PDF/HTML/편집 임시파일 정리 (누적 방지)
function sweepTempConversions() {
  try {
    const dir = os.tmpdir();
    const re = /^(hwpconv|officeconv|adobeconv)_.*\.pdf$|^quote_.*\.html$|^pdfedit_.*\.(pdf|bin)$|^remoteup_.*$/i;
    for (const f of fs.readdirSync(dir)) {
      if (re.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} }
    }
  } catch (e) {}
}

// ── 줌 단축키 (Ctrl++/Ctrl+-/Ctrl+0) — 메인·편집기 창 공통 ──────────────────
function installZoomShortcuts(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (!input.control) return;
    const wc = win.webContents;
    if (input.type !== 'keyDown') return;
    if (input.key === '=' || input.key === '+') {
      wc.setZoomLevel(wc.getZoomLevel() + 0.5); event.preventDefault();
    } else if (input.key === '-') {
      wc.setZoomLevel(wc.getZoomLevel() - 0.5); event.preventDefault();
    } else if (input.key === '0') {
      wc.setZoomLevel(0); event.preventDefault();
    }
  });
}

// ── 라이선스: 창·IPC·저장 게이트 ────────────────────────────────────────────
// 저장·출력은 전부 메인 프로세스를 지나므로, 검사도 여기 한 곳에 모은다.
// 렌더러(화면) 코드를 고쳐도 파일이 밖으로 나가지 못하게 하는 것이 목적.
let licWin = null;
function openLicenseWindow(focusAdmin) {
  if (licWin && !licWin.isDestroyed()) { licWin.focus(); return licWin; }
  licWin = new BrowserWindow({
    width: 720, height: 640, title: 'PDF Editor — 체험판 인증',
    icon: path.join(__dirname, 'src', 'icon.ico'),
    parent: mainWin && !mainWin.isDestroyed() ? mainWin : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-license.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  licWin.loadFile(path.join(__dirname, 'src', 'license.html'));
  licWin.on('closed', () => {
    licWin = null;
    // 창을 닫으면 메인 화면의 배지·버튼 상태를 최신 판정으로 맞춘다
    pushLicenseStatus();
  });
  return licWin;
}
function pushLicenseStatus() {
  const st = license.refresh();
  BrowserWindow.getAllWindows().forEach(w => {
    try { w.webContents.send('license:status', st); } catch (e) {}
  });
  return st;
}
// 저장·출력 길목의 공통 관문. 막을 때는 이유를 다이얼로그로 알리고 인증 창을 띄운다.
function licenseGate(what) {
  // status()(캐시)가 아니라 refresh()로 그 자리에서 다시 판정한다 —
  // 앱을 켜 둔 채 기간이 끝나거나 시계가 바뀐 경우를 저장 시점에 잡아내기 위함.
  const st = license.refresh();
  if (st.canSave) return true;
  const msg = st.mode === 'none'
    ? `체험 키를 등록해야 ${what}을(를) 저장할 수 있습니다.\n\n발급자에게 받은 키를 인증 창에 입력하세요.`
    : `${st.reason || '라이선스가 유효하지 않습니다.'}\n\n${what} 저장이 차단되었습니다. (열기·분석·미리보기는 계속 사용할 수 있습니다)`;
  dialog.showMessageBox(mainWin && !mainWin.isDestroyed() ? mainWin : null, {
    type: 'warning', title: '체험판 인증 필요', message: st.label || '인증 필요', detail: msg,
    buttons: ['인증 창 열기', '취소'], defaultId: 0, cancelId: 1, noLink: true,
  }).then(r => { if (r.response === 0) openLicenseWindow(); });
  return false;
}

ipcMain.handle('lic:status',      () => license.refresh());
ipcMain.handle('lic:hwid',        () => license.hwid());
ipcMain.handle('lic:savedServer', () => license.savedServer());
ipcMain.handle('lic:activate',    async (_, { key, server }) => {
  const r = await license.activate(key, server);
  pushLicenseStatus();
  return r;
});
ipcMain.handle('lic:recheck',     async () => {
  const r = await license.recheckIfDue(true);
  pushLicenseStatus();
  return r;
});
// 오프라인 등록 — 서버에 닿지 않는 테스터용(요청 코드 ↔ 활성화 코드 왕복)
ipcMain.handle('lic:offlineRequest',  (_, { key }) => license.offlineRequest(key));
ipcMain.handle('lic:offlineActivate', (_, { token }) => {
  const r = license.offlineActivate(token);
  pushLicenseStatus();
  return r;
});
ipcMain.on('lic:close', () => { if (licWin && !licWin.isDestroyed()) licWin.close(); });
// 관리자(개인키 보유 PC) 전용 — 권한 확인은 license.js 안에서 한다
ipcMain.handle('lic:admin:issue',        (_, { days, note }) => license.issueKey({ days, note }));
ipcMain.handle('lic:admin:list',         () => license.listKeys());
ipcMain.handle('lic:admin:revoke',       (_, { key }) => license.revokeKey(key));
ipcMain.handle('lic:admin:serverStatus', () => licenseServer.status());
ipcMain.handle('lic:admin:setServer',    (_, { enabled, port }) => {
  if (!license.isAdminPC()) return licenseServer.status();
  return licenseServer.setEnabled(enabled, port);
});
ipcMain.handle('lic:admin:lanIps', () => {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifs)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^169\.254\./.test(a.address) || /virtual|vmware|vbox|wsl|loopback/i.test(name)) continue;
      out.push(a.address);
    }
  }
  return out;
});
ipcMain.handle('lic:admin:offlineIssue', (_, { code }) => license.offlineIssue(code));
// 외부 접속 터널 — 포트포워딩이 안 되는 회선에서 활성화 서버를 열어준다
ipcMain.handle('lic:admin:tunnelStatus', () => licenseTunnel.status());
ipcMain.handle('lic:admin:tunnel', async (_, { on, port }) => {
  if (!license.isAdminPC()) return licenseTunnel.status();
  return on ? await licenseTunnel.start(port) : licenseTunnel.stop();
});
ipcMain.handle('lic:admin:tunnelInstall', async () => {
  if (!license.isAdminPC()) return { ok: false, error: '권한 없음' };
  return await licenseTunnel.install();
});
// 메인 화면에서 인증 창 열기 (배지 클릭 / Ctrl+Shift+Alt+L)
ipcMain.handle('lic:open', () => { openLicenseWindow(); return true; });

function createWindow() {
  const win = mainWin = new BrowserWindow({
    width:  1280,
    height: 900,
    minWidth:  900,
    minHeight: 600,
    title: 'PDF Editor',
    icon: path.join(__dirname, 'src', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,   // preload에서 fs/path 등 Node.js 내장 모듈 사용 허용
      backgroundThrottling: false, // 창이 비활성일 때도 렌더링 속도 유지
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  // win.webContents.openDevTools(); // 디버그 시 주석 해제

  // 실행 인자로 받은 문서를 렌더러 준비 후 전달 (목차 검증기 연동)
  // Ctrl+R / Ctrl+Shift+R — 기본 메뉴의 새로고침을 가로채 렌더러의 확인 절차를 태운다.
  // (그냥 두면 편집 중이던 문서가 경고 없이 날아간다)
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    // Ctrl+Shift+Alt+L — 인증·발급 창 (관리자 PC에서는 발급 탭이 함께 열린다)
    if (input.control && input.shift && input.alt && (input.key === 'l' || input.key === 'L')) {
      event.preventDefault();
      openLicenseWindow();
      return;
    }
    if (!input.control || input.alt) return;
    if (input.key === 'r' || input.key === 'R' || input.key === 'F5') {
      event.preventDefault();
      win.webContents.send('app:reload-request');
    }
  });

  // 렌더러가 blob/data URL 다운로드로 저장 길목을 우회하지 못하게 막는다
  // (지금 코드엔 그런 경로가 없지만, 화면 코드를 고쳐 넣는 우회를 여기서 차단)
  win.webContents.session.on('will-download', (e, item) => {
    if (!license.refresh().canSave) {
      e.preventDefault();
      licenseGate(item.getFilename() || '파일');
    }
  });

  // 창이 뜨면 현재 라이선스 상태를 화면에 알린다 (배지·안내 표시용)
  win.webContents.on('did-finish-load', () => {
    try { win.webContents.send('license:status', license.status()); } catch (e) {}
  });

  win.webContents.on('did-finish-load', () => {
    if (pendingOpenPaths.length) {
      // 항목은 경로 문자열 또는 { path, name }(인쇄 접수처럼 표시 이름이 따로 있는 경우)
      win.webContents.send(
        'external:open',
        pendingOpenPaths.map((p) => (typeof p === 'string' ? { path: p, name: path.basename(p) } : p))
      );
      pendingOpenPaths = [];
    }
  });

  // ── 종료 전 저장 여부 확인 ──────────────────────────────────────────────
  win.on('close', (e) => {
    if (forceClose || !unsavedWork) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['취소', '저장 안 하고 종료'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: '종료 확인',
      message: '저장하지 않은 편집·적용 결과가 있습니다.',
      detail: "저장하려면 '취소'를 누른 뒤 ‘📥 다운로드’로 저장하세요.\n그래도 종료하시겠습니까?",
    });
    if (choice === 1) { forceClose = true; win.destroy(); }
  });

  // ── 줌 단축키 (Ctrl++/Ctrl+-/Ctrl+0) ────────────────────────────────────
  installZoomShortcuts(win);
}

// ── 페이지 내부편집기 창 ────────────────────────────────────────────────────
// 큰 PDF는 IPC로 직렬화하지 않는다(50MB+ 손상 우려). 원본/편집 결과 PDF는 임시파일로
// 주고받고(경로만 IPC), 편집기는 preload.readFile(fs)로 직접 읽는다.
// pendingEditorPayload: 편집기 webContents.id → { payload(작은 JSON+경로), openerId }
const pendingEditorPayload = new Map();

function createEditorWindow(openerId, payload) {
  const parent = BrowserWindow.getAllWindows().find(w => w.webContents.id === openerId);
  const win = new BrowserWindow({
    width: 1400, height: 950,
    minWidth: 1000, minHeight: 640,
    title: '내부 편집기 — PDF 분석기',
    icon: path.join(__dirname, 'src', 'icon.ico'),
    parent: parent || undefined,   // 부모 위에 표시(모달 아님 — 페이지 탐색 가능)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    }
  });
  const wcId = win.webContents.id;   // 'closed' 후엔 win.webContents 접근 시 destroyed 예외 → 미리 캡처
  pendingEditorPayload.set(wcId, { payload, openerId });
  installZoomShortcuts(win);
  win.loadFile(path.join(__dirname, 'src', 'editor.html'));
  win.on('closed', () => { pendingEditorPayload.delete(wcId); });
  return win;
}

// 편집기 열기 요청 (opener 렌더러 → main)
ipcMain.handle('editor:open', (event, payload) => {
  createEditorWindow(event.sender.id, payload || {});
  return true;
});
// 편집기 창이 로드 후 자신의 페이로드를 당겨간다
ipcMain.handle('editor:pull', (event) => {
  const entry = pendingEditorPayload.get(event.sender.id);
  return entry ? entry.payload : null;
});
// 편집기 저장 → opener 렌더러로 결과 전달 후 편집기 창 닫기
ipcMain.on('editor:save', (event, result) => {
  const entry = pendingEditorPayload.get(event.sender.id);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (entry) {
    const opener = BrowserWindow.getAllWindows().find(w => w.webContents.id === entry.openerId);
    if (opener && !opener.isDestroyed()) opener.webContents.send('editor:result', result || {});
  }
  if (win && !win.isDestroyed()) win.close();
});
// 편집기 취소로 닫기 (결과 전달 없음)
ipcMain.on('editor:close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
});

app.whenReady().then(() => {
  // 라이선스 먼저 — 저장 게이트가 창보다 앞서 준비돼 있어야 한다
  license.init({ userDataDir: app.getPath('userData'), appVersion: app.getVersion() });
  licenseServer.init(license, {
    load: () => {
      try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'license-server.json'), 'utf8')); }
      catch (e) { return { enabled: false, port: licenseServer.PORT_DEFAULT }; }
    },
    save: (cfg) => {
      try { fs.writeFileSync(path.join(app.getPath('userData'), 'license-server.json'), JSON.stringify(cfg, null, 2), 'utf8'); } catch (e) {}
    },
  });
  sweepTempConversions(); // 시작 시 이전 세션 변환 임시파일 정리
  initRemoteServer();     // 모바일 연동 서버 (켜짐 설정이면 자동 구동)
  ensureSendToShortcut(); // 탐색기 '보내기' 메뉴 등록 (포터블 실행 시)
  ingestPendingPrintOnBoot(); // 꺼진 동안 인쇄된 결과물이 있으면 열기 (createWindow 전에)
  startPrintWatcher();    // 가상 프린터 'PDF Editor' 출력 감시
  initPrintDocNameSources();  // 접수 문서의 '원래 이름' 회수 경로 준비 (로그 / 작업 큐)
  setTimeout(repairPrintWatchdogIfNeeded, 6000);   // 상주 감시자 자동 복구 (프린터 설치 시)
  createWindow();
  // 인증이 없거나 만료면 인증 창을 함께 띄운다. 앱 자체는 열어 둔다 —
  // 열기·분석·미리보기는 되고 저장·출력만 막히는 것이 이 체험판의 규칙이다.
  const st = license.status();
  if (!st.canSave) setTimeout(() => openLicenseWindow(), 700);
  // 7일 주기 서버 재확인 — 부팅 직후 한 번, 이후 6시간마다. 실패해도 유예 안에서는 조용히 넘어간다.
  setTimeout(() => license.recheckIfDue().then(pushLicenseStatus).catch(() => {}), 5000);
  setInterval(() => license.recheckIfDue().then(pushLicenseStatus).catch(() => {}), 6 * 3600 * 1000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', sweepTempConversions); // 종료 시에도 한 번 더 정리
app.on('will-quit', stopPrintJobPoller);   // 인쇄 작업 감시 프로세스 정리(상주했다면)
app.on('will-quit', () => { try { licenseTunnel.stop(); } catch (e) {} }); // cloudflared 자식 프로세스 정리

// 렌더러 → '저장 안 한 작업' 상태 보고
ipcMain.on('app:dirty', (_, dirty) => { unsavedWork = !!dirty; });

// 렌더러 → 앱 강제 새로고침(캐시 무시). 화면·상태가 꼬였을 때 앱을 껐다 켜지 않고 복구한다.
// 새로고침하면 편집 내용이 사라지므로 '저장 안 한 작업' 플래그도 함께 해제한다.
ipcMain.handle('app:forceReload', (event) => {
  const w = BrowserWindow.fromWebContents(event.sender);
  if (!w) return false;
  unsavedWork = false;
  w.webContents.reloadIgnoringCache();
  return true;
});

// 렌더러 → 설치된 시스템 폰트 목록 (이름·경로). 임베드 가능한 TTF/OTF만.
// 폰트 레지스트리(HKLM/HKCU)에서 표시 이름→파일을 읽어 반환. TTC는 pdf-lib 임베드 불가라 제외.
ipcMain.handle('fonts:list', () => {
  return new Promise((resolve) => {
    const psScript = [
      // 한글 폰트명이 깨지지 않도록 stdout 인코딩을 UTF-8로 (Node는 utf8로 디코드)
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      '$ErrorActionPreference="SilentlyContinue"',
      '$out=@()',
      "$hives=@('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts','HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts')",
      'foreach($h in $hives){ if(Test-Path $h){ foreach($p in (Get-ItemProperty $h).PSObject.Properties){',
      '  $v=$p.Value',
      "  if($v -is [string] -and $v -match '\\.(ttf|otf)$'){",
      "    if($v -match '[\\\\/]'){ $path=$v } else { $path=Join-Path $env:WINDIR ('Fonts\\'+$v) }",
      "    if(Test-Path $path){ $name=$p.Name -replace ' \\((TrueType|OpenType)\\)',''; $out+=[pscustomobject]@{name=$name;file=$path} }",
      '  } } } }',
      '$out | Sort-Object name -Unique | ConvertTo-Json -Compress',
    ].join('; ');
    const enc = Buffer.from(psScript, 'utf16le').toString('base64');
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
      { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) { resolve([]); return; }
        try {
          const j = JSON.parse(stdout.trim());
          resolve(Array.isArray(j) ? j : [j]);
        } catch (e) { resolve([]); }
      });
  });
});

// ── IPC: Ghostscript inkcov — 페이지별 CMYK 잉크 커버리지 (프린터 기준 컬러 판정) ──
// 렌더러가 임시파일(pdfedit_*.pdf)로 PDF를 넘기면 gswin64c inkcov로 페이지별
// C/M/Y/K 비율을 파싱해 반환한다. CMY>0 이면 프린터가 컬러로 과금할 수 있는 페이지.
// 반드시 '-o -'(stdout)로 받아야 함 — '-o nul'이면 커버리지 출력이 사라진다.
// gswin64c 실행 파일 탐색 — PATH에 없으면 표준 설치 폴더(C:\Program Files\gs\gs*)에서 찾는다.
let _gsPath = null;
function findGhostscript() {
  if (_gsPath) return _gsPath;
  // ① 앱에 동봉된 런타임을 최우선 — 테스터 PC에 Ghostscript가 없어도 잉크 판정·폰트
  //    안전화가 그대로 동작한다(설치·다운로드·7-Zip 불필요). 포터블 exe는 실행 시
  //    resources/ 아래로 풀리므로 process.resourcesPath 기준으로 찾는다.
  for (const base of [path.join(process.resourcesPath || '', 'gs'), path.join(__dirname, 'vendor', 'gs')]) {
    try {
      const exe = path.join(base, 'bin', 'gswin64c.exe');
      if (fs.existsSync(exe)) { _gsPath = exe; return exe; }
    } catch (e) {}
  }
  for (const pf of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
    if (!pf) continue;
    const gsRoot = path.join(pf, 'gs');
    try {
      const vers = fs.readdirSync(gsRoot).filter(d => /^gs[\d.]+$/i.test(d)).sort().reverse();
      for (const v of vers) {
        const exe = path.join(gsRoot, v, 'bin', 'gswin64c.exe');
        if (fs.existsSync(exe)) { _gsPath = exe; return exe; }
      }
    } catch (e) {}
  }
  _gsPath = 'gswin64c';   // PATH 폴백
  return _gsPath;
}

// gs inkcov 실행 — IPC 핸들러와 원격 서버(remote-server.js)가 공유
function runInkCoverage(pdfPath) {
  return new Promise((resolve, reject) => {
    try {
      const base = path.basename(pdfPath || '');
      if (!/^pdfedit_.*\.pdf$/i.test(base)) return reject(new Error('잘못된 임시파일 경로'));
      if (path.dirname(pdfPath) !== os.tmpdir()) return reject(new Error('잘못된 임시파일 경로'));
    } catch (e) { return reject(e); }
    execFile(findGhostscript(),
      ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=inkcov', '-o', '-', pdfPath],
      { windowsHide: true, timeout: 300000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (err.code === 'ENOENT')
            ? 'Ghostscript(gswin64c)가 설치되어 있지 않습니다. 프린터 잉크 판정에는 Ghostscript가 필요합니다.'
            : ((stderr || err.message || '').toString().slice(0, 300) || 'Ghostscript 실행 실패');
          return reject(new Error(msg));
        }
        const pages = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          const m = line.match(/^\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+CMYK\s+OK/);
          if (m) pages.push({ c: +m[1], m: +m[2], y: +m[3], k: +m[4] });
        }
        if (!pages.length) return reject(new Error('inkcov 출력을 해석하지 못했습니다.'));
        resolve(pages);
      });
  });
}

ipcMain.handle('ink:coverage', (_, pdfPath) => runInkCoverage(pdfPath));

// ── IPC: 폰트 아웃라인화 — gs pdfwrite -dNoOutputFonts (모든 텍스트 → 곡선) ──
// 외부 출력소 전달 표준 관행: 폰트 문제로 인한 출력 사고 원천 차단.
ipcMain.handle('gs:outlineFonts', (_, pdfPath, opts) => {
  return new Promise((resolve, reject) => {
    try {
      const base = path.basename(pdfPath || '');
      if (!/^pdfedit_.*\.pdf$/i.test(base)) return reject(new Error('잘못된 임시파일 경로'));
      if (path.dirname(pdfPath) !== os.tmpdir()) return reject(new Error('잘못된 임시파일 경로'));
    } catch (e) { return reject(e); }
    const outPath = path.join(os.tmpdir(), `pdfedit_outline_${Date.now()}.pdf`);
    // 이미지 무손실 명시: 재기록 과정의 다운샘플링 금지 + 원본 JPEG 통과(재압축 없음)
    // flatten: PDF 1.4 강제 → 투명도 평탄화(구형 RIP 대응). 기본은 1.6(투명도 유지).
    // mode 'embed': 곡선화 대신 모든 폰트를 완전(비서브셋) 임베드 — 용량 증가가 폰트
    // 파일 크기 정도로 그침. 미임베드 폰트는 FONTPATH(윈도우 폰트 폴더)에서 찾아 싣는다.
    const compat = opts && opts.flatten ? '1.4' : '1.6';
    const embed = opts && opts.mode === 'embed';
    const winFonts = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
    // embed 모드는 -q를 빼고 gs 로그를 함께 반환 — "Loading font X (or substitute) from %rom%..."
    // 메시지로 '이 PC에도 없어 대체된 폰트'를 렌더러가 감지해 해당 페이지를 이미지화한다.
    execFile(findGhostscript(),
      [...(embed ? [] : ['-q']), '-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite',
       ...(embed
         ? ['-dEmbedAllFonts=true', '-dSubsetFonts=false', '-dCompressFonts=true', `-sFONTPATH=${winFonts}`]
         : ['-dNoOutputFonts']),
       '-dPassThroughJPEGImages=true',
       '-dDownsampleColorImages=false', '-dDownsampleGrayImages=false', '-dDownsampleMonoImages=false',
       `-dCompatibilityLevel=${compat}`, '-o', outPath, pdfPath],
      { windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (err.code === 'ENOENT')
            ? 'Ghostscript(gswin64c)가 설치되어 있지 않습니다. 폰트 아웃라인화에는 Ghostscript가 필요합니다.'
            : ((stderr || err.message || '').toString().slice(0, 300) || 'Ghostscript 실행 실패');
          return reject(new Error(msg));
        }
        if (!fs.existsSync(outPath)) return reject(new Error('아웃라인 PDF가 생성되지 않았습니다.'));
        resolve(embed ? { path: outPath, log: String(stdout || '') + '\n' + String(stderr || '') } : outPath);
      });
  });
});

// 렌더러 → 사용 끝난 변환 임시 PDF 삭제 (tmpdir 내 변환파일만)
ipcMain.handle('temp:cleanup', (_, p) => {
  try {
    if (!p) return false;
    const base = path.basename(p);
    if (!/^(hwpconv|officeconv|adobeconv)_.*\.pdf$/i.test(base)) return false;
    if (path.dirname(p) !== os.tmpdir()) return false;
    fs.unlinkSync(p);
    return true;
  } catch (e) { return false; }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: 파일 열기 다이얼로그 ──────────────────────────────────────────────
// ── IPC: AI 뒤표지 이미지 생성 — OpenAI Images API (gpt-image-1) ──────────────
// 렌더러는 CORS 때문에 직접 호출 불가 → 메인에서 호출하고 임시 PNG 경로만 반환.
// 키는 렌더러(localStorage)가 들고 있다가 호출 시에만 전달 — 파일로 저장하지 않는다.
ipcMain.handle('ai:genCoverImage', async (_, opts) => {
  const { apiKey, prompt, size } = opts || {};
  if (!apiKey || !String(apiKey).trim()) throw new Error('API 키가 비어 있습니다');
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 180000);   // 3분 상한
  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${String(apiKey).trim()}` },
      body: JSON.stringify({ model: 'gpt-image-1', prompt: String(prompt || ''), size: size || '1024x1536', n: 1 }),
      signal: ctrl.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j.error && j.error.message) || ('이미지 생성 API 오류 (HTTP ' + res.status + ')'));
    const b64 = j.data && j.data[0] && j.data[0].b64_json;
    if (!b64) throw new Error('이미지 생성 응답이 비어 있습니다');
    const out = path.join(os.tmpdir(), `pdfedit_aicover_${Date.now()}.png`);
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    return out;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('이미지 생성 시간 초과(3분) — 네트워크를 확인하세요');
    throw e;
  } finally { clearTimeout(to); }
});

// ── 📂 표지 핫폴더 — 폴더 감시는 메인, 표지 생성은 렌더러(pdf-lib·캔버스 필요) ──
// 구조: 핫폴더\{본문, 표지, 완료, 실패}. 파일 크기가 2회 연속 같아지면(쓰기 완료) 렌더러에
// 잡을 보내고, 렌더러가 결과 임시파일 경로로 finish를 호출하면 여기서 이동·정리한다.
let _hfTimer = null, _hfDir = null;
const _hfBusy = new Set(), _hfSizes = new Map();
const HF_KINDS = { '본문': 'body', '표지': 'cover' };
const HF_EXTS = /\.(pdf|ai|psd|png|jpg|jpeg)$/i;
function hfSubdirs(dir) { return ['본문', '표지', '완료', '실패'].map(s => path.join(dir, s)); }
function hfUniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p), base = p.slice(0, -ext.length || undefined);
  for (let i = 1; i < 1000; i++) { const q = `${base} (${i})${ext}`; if (!fs.existsSync(q)) return q; }
  return `${base}.${Date.now()}${ext}`;
}
function hfPoll() {
  if (!_hfDir) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  for (const [sub, kind] of Object.entries(HF_KINDS)) {
    let files = [];
    try { files = fs.readdirSync(path.join(_hfDir, sub)).filter(f => HF_EXTS.test(f)); } catch (e) { continue; }
    for (const f of files) {
      const p = path.join(_hfDir, sub, f);
      if (_hfBusy.has(p)) continue;
      let size = -1;
      try { size = fs.statSync(p).size; } catch (e) { continue; }
      if (size <= 0) continue;
      if (_hfSizes.get(p) === size) {          // 크기 안정 = 복사 완료
        _hfBusy.add(p);
        _hfSizes.delete(p);
        win.webContents.send('hotfolder:job', { path: p, kind, name: f });
      } else {
        _hfSizes.set(p, size);
      }
    }
  }
}
ipcMain.handle('hotfolder:start', (_, dir) => {
  try {
    if (!dir || !fs.existsSync(dir)) return { ok: false, error: '폴더가 없습니다' };
    hfSubdirs(dir).forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} });
    _hfDir = dir;
    _hfBusy.clear(); _hfSizes.clear();
    clearInterval(_hfTimer);
    _hfTimer = setInterval(hfPoll, 2500);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('hotfolder:stop', () => { clearInterval(_hfTimer); _hfTimer = null; _hfDir = null; _hfBusy.clear(); _hfSizes.clear(); return true; });
// 렌더러 처리 완료 → 원본·결과 이동 (성공: 완료\, 실패: 실패\ + 사유 텍스트)
ipcMain.handle('hotfolder:finish', (_, r) => {
  // 핫폴더 무인 저장도 결과물 반출 — 만료 시 결과를 '완료' 폴더로 내보내지 않는다
  if (r && r.ok && !license.refresh().canSave) {
    try { if (r.outTmp && fs.existsSync(r.outTmp)) fs.unlinkSync(r.outTmp); } catch (e) {}
    _hfBusy.delete(r.srcPath);
    licenseGate('핫폴더 결과');
    return false;
  }
  try {
    const dir = _hfDir;
    if (!dir || !r || !r.srcPath) return false;
    const doneDir = path.join(dir, '완료'), failDir = path.join(dir, '실패');
    if (r.ok) {
      if (r.outTmp && fs.existsSync(r.outTmp)) fs.renameSync(r.outTmp, hfUniquePath(path.join(doneDir, r.outName || 'cover.pdf')));
      if (fs.existsSync(r.srcPath)) fs.renameSync(r.srcPath, hfUniquePath(path.join(doneDir, path.basename(r.srcPath))));
    } else {
      if (fs.existsSync(r.srcPath)) fs.renameSync(r.srcPath, hfUniquePath(path.join(failDir, path.basename(r.srcPath))));
      try { fs.writeFileSync(hfUniquePath(path.join(failDir, path.basename(r.srcPath) + '.실패사유.txt')), String(r.errMsg || '알 수 없는 오류'), 'utf8'); } catch (e) {}
    }
    _hfBusy.delete(r.srcPath);
    return true;
  } catch (e) { _hfBusy.delete(r && r.srcPath); return false; }
});
// 폴더 선택 다이얼로그 (핫폴더 지정용)
ipcMain.handle('dialog:pickFolder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ title: '핫폴더 선택', properties: ['openDirectory', 'createDirectory'] });
  return (canceled || !filePaths.length) ? null : filePaths[0];
});

// 표지 파일 선택 — PDF(1쪽째 사용) 또는 이미지
ipcMain.handle('dialog:openCoverFile', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '표지 파일 선택 (PDF · 이미지 · AI · PSD)',
    filters: [
      { name: '표지 파일 (PDF·이미지·AI·PSD)', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'ai', 'psd'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: '이미지 (PNG·JPG)', extensions: ['png', 'jpg', 'jpeg'] },
      { name: 'Adobe (AI·PSD)', extensions: ['ai', 'psd'] },
    ],
    properties: ['openFile'],
  });
  return (canceled || !filePaths.length) ? null : filePaths[0];
});

ipcMain.handle('dialog:openFile', async (_e, opts) => {
  // kind:'pdfw' — 💼 작업 파일 전용 다이얼로그 (그 외에는 지금까지처럼 문서·이미지 전체)
  if (opts && opts.kind === 'pdfw') {
    const r = await dialog.showOpenDialog({
      title: '작업 파일 열기',
      filters: [{ name: 'PDF Editor 작업 파일', extensions: ['pdfw'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return [];
    return r.filePaths.map(fp => ({ path: fp, name: path.basename(fp) }));
  }
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '파일 선택 (PDF · HWP · HWPX · MS Office · Adobe · 이미지)',
    filters: [
      { name: '문서·이미지 전체 (PDF·HWP·Office·Adobe·이미지)',
        extensions: ['pdf', 'hwp', 'hwpx', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'ai', 'psd', 'indd',
                     'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'avif'] },
      { name: '이미지 (PNG·JPG·GIF·BMP·WEBP·TIFF)', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'avif'] },
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
// 같은 이름이 이미 있으면 파일명 끝에 -1, -2 …를 붙여 겹치지 않는 경로를 만든다.
// (인쇄 실무상 같은 원고를 설정만 바꿔 여러 번 뽑는 일이 잦아, 덮어쓰기 경고보다
//  자동 번호가 안전하다. 사용자가 다이얼로그에서 이름을 다시 바꾸는 것은 자유.)
let _lastSaveDir = null;   // 저장 다이얼로그 기본 폴더 — 문서를 연 폴더 → 이후엔 직전 저장 폴더
// 렌더러가 문서를 열면 그 파일이 있던 폴더를 저장 기본 위치로 삼는다 ("해당 폴더에 저장")
ipcMain.on('app:docDir', (_e, dir) => {
  try { if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) _lastSaveDir = dir; } catch (e) {}
});
function uniqueSavePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p) && i < 1000; i++) p = path.join(dir, `${stem}-${i}${ext}`);
  return p;
}
ipcMain.handle('dialog:saveFilePath', async (_, { defaultName, kind }) => {
  // kind:'html' — E-book 시안 등 PDF가 아닌 산출물. 없으면 지금까지처럼 PDF로 동작한다.
  const isHtml = kind === 'html';
  const isWork = kind === 'pdfw';
  if (!licenseGate(isHtml ? '시안 HTML' : isWork ? '작업 파일' : 'PDF')) return null;   // 체험판 만료·미인증 → 저장 경로를 주지 않는다
  // 기본 폴더 = 문서를 연 폴더(app:docDir) → 그 뒤로는 직전 저장 폴더, 둘 다 없으면 다운로드
  let dir = _lastSaveDir;
  try { if (!dir || !fs.existsSync(dir)) dir = app.getPath('downloads'); } catch (e) { dir = null; }
  const defaultPath = dir ? uniqueSavePath(dir, defaultName) : defaultName;
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: isHtml ? '시안 HTML 저장' : isWork ? '작업 파일 저장' : 'PDF 저장',
    defaultPath,
    filters: isHtml ? [{ name: 'HTML 시안', extensions: ['html'] }]
           : isWork ? [{ name: 'PDF Editor 작업 파일', extensions: ['pdfw'] }]
                    : [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  try { _lastSaveDir = path.dirname(filePath); } catch (e) {}
  return filePath;
});

// ── IPC: 견적서 HTML → PDF 변환 (숨겨진 BrowserWindow + printToPDF) ──────────
// Electron 26+ 에서 margins 단위가 인치로 변경됨 → marginType:'none' 사용 (HTML body padding으로 여백 처리)
// loadURL 완료를 did-finish-load 이벤트로 명시적 대기
// HTML → PDF 렌더 — IPC(견적서)와 원격 서버(모바일 견적서)가 공유
async function renderHtmlToPdf(html) {
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
}
ipcMain.handle('print:toPDF', (_, html) => {
  // 견적서 PDF도 '출력물' — 체험판 만료 시 함께 막는다
  if (!licenseGate('견적서')) return null;
  return renderHtmlToPdf(html);
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

// 이전 변환의 성공/실패와 무관하게 다음 변환을 순차로 이어 실행.
// IPC와 원격 서버(remote-server.js)가 같은 큐를 공유 — PC·폰 요청이 충돌 없이 직렬화된다.
function enqueueHwpConvert(srcPath) {
  const run = () => convertHwpToPdf(srcPath);
  const result = hwpQueue.then(run, run);
  // 큐 체인은 실패가 전파되지 않도록 별도로 유지 (반환 promise만 실제 결과)
  hwpQueue = result.catch(() => {});
  return result;
}
ipcMain.handle('hwp:convertToPdf', (_, srcPath) => enqueueHwpConvert(srcPath));

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

function enqueueOfficeConvert(srcPath) {
  const run = () => convertOfficeToPdf(srcPath);
  const result = officeQueue.then(run, run);
  officeQueue = result.catch(() => {});
  return result;
}
ipcMain.handle('office:convertToPdf', (_, srcPath) => enqueueOfficeConvert(srcPath));

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

function enqueueAdobeConvert(srcPath) {
  const run = () => convertAdobeToPdf(srcPath);
  const result = adobeQueue.then(run, run);
  adobeQueue = result.catch(() => {});
  return result;
}
ipcMain.handle('adobe:convertToPdf', (_, srcPath) => enqueueAdobeConvert(srcPath));

// ── 모바일 연동 LAN 변환 서버 — 렌더러 설정 UI와 연결 ────────────────────────
// 변환 함수(큐 공유)·잉크 판정을 서버에 주입. 켜짐 설정이면 앱 시작 시 자동 구동.
function initRemoteServer() {
  const cfg = remoteServer.init({
    userDataDir: app.getPath('userData'),
    version: app.getVersion(),
    convert: { hwp: enqueueHwpConvert, office: enqueueOfficeConvert, adobe: enqueueAdobeConvert },
    inkCoverage: runInkCoverage,
    htmlToPdf: renderHtmlToPdf,   // 모바일 견적서 PDF 저장용
  });
  if (cfg.enabled) remoteServer.start();
}
ipcMain.handle('remote:status', () => remoteServer.status());
ipcMain.handle('remote:setEnabled', (_, on) => remoteServer.setEnabled(!!on));
