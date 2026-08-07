# ============================================================================
#  PDF 분석기 — 포터블 앱 원클릭 설치 (다른 PC 셋업용)
#  앱 자체는 설치가 필요 없습니다(폴더 복사만). 이 스크립트는 앱 밖에서
#  한 번만 해 두어야 하는 OS 연동·외부 도구를 한꺼번에 처리합니다.
#
#  사용:  설치.bat 더블클릭   (또는)
#         powershell -ExecutionPolicy Bypass -File install-portable.ps1
#         -Check      : 설치하지 않고 현재 상태만 점검
#         -Uninstall  : 이 스크립트가 만든 연동을 제거
#         -Firewall   : 모바일 연동(원격 서버) 방화벽 허용도 함께 설정
#         -Quiet      : 모든 질문에 기본값으로 자동 응답
# ============================================================================
param(
  [switch]$Check,
  [switch]$Uninstall,
  [switch]$Firewall,
  [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$PRINTER   = 'PDF Editor'
$DRIVER    = 'Microsoft Print To PDF'
$APPDIRNAME = 'pdf-analyzer'          # Electron userData 폴더명 (package.json의 name)
$EXENAME   = 'PDF 분석기.exe'
$RUNKEY    = 'PDFEditorPrintWatch'
$PRINTLOG  = 'Microsoft-Windows-PrintService/Operational'
$FWRULE    = 'PDF 분석기 모바일 연동'
$FWPORT    = 8734

function Say($msg, $color) {
  if ($color) { Write-Host $msg -ForegroundColor $color } else { Write-Host $msg }
}
function Head($msg) { Write-Host ''; Say "── $msg " 'Yellow' }
function OK($msg)   { Say "   [완료] $msg" 'Green' }
function Info($msg) { Say "   [정보] $msg" 'Gray' }
function Warn($msg) { Say "   [주의] $msg" 'DarkYellow' }
function Fail($msg) { Say "   [실패] $msg" 'Red' }
function Ask($msg, $defaultYes) {
  if ($Quiet) { return $defaultYes }
  $suffix = '[y/N]'
  if ($defaultYes) { $suffix = '[Y/n]' }
  $a = Read-Host "   $msg $suffix"
  if ([string]::IsNullOrWhiteSpace($a)) { return $defaultYes }
  return ($a -match '^[yY]')
}

# ── 관리자 승격 (프린터 추가·인쇄 로그 활성화에 필요) ──────────────────────
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not $Check -and -not (Test-Admin)) {
  Say '관리자 권한이 필요합니다 — 권한 상승 창(UAC)을 띄웁니다…' 'Yellow'
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($Uninstall) { $argList += '-Uninstall' }
  if ($Firewall)  { $argList += '-Firewall' }
  if ($Quiet)     { $argList += '-Quiet' }
  try { Start-Process powershell -Verb RunAs -ArgumentList $argList }
  catch { Fail '권한 상승이 취소되었습니다. 설치를 중단합니다.'; Read-Host '엔터를 누르면 닫힙니다'; exit 1 }
  exit 0
}

# ── 앱 실행 파일 찾기 (스크립트 폴더 → 상위 폴더 순) ────────────────────────
function Find-AppExe {
  $dirs = @($PSScriptRoot, (Split-Path $PSScriptRoot -Parent))
  foreach ($d in $dirs) {
    if (-not $d) { continue }
    $p = Join-Path $d $EXENAME
    if (Test-Path $p) { return $p }
    $p2 = Join-Path $d "dist\win-unpacked\$EXENAME"
    if (Test-Path $p2) { return $p2 }
  }
  $found = Get-ChildItem -Path $PSScriptRoot -Filter $EXENAME -Recurse -ErrorAction SilentlyContinue |
           Select-Object -First 1
  if ($found) { return $found.FullName }
  return $null
}

$portDir  = Join-Path $env:APPDATA "$APPDIRNAME\printjobs"
$portFile = Join-Path $portDir 'print_output.pdf'
$appExe   = Find-AppExe

Write-Host ''
Say '═══════════════════════════════════════════════════════════' 'Cyan'
Say '  PDF 분석기 — 포터블 앱 셋업' 'Cyan'
Say '═══════════════════════════════════════════════════════════' 'Cyan'
if ($appExe) { Info "앱 위치: $appExe" } else { Warn "$EXENAME 을(를) 찾지 못했습니다 — 이 스크립트를 앱 폴더에 두고 실행하세요." }

# ============================================================================
#  제거 모드
# ============================================================================
if ($Uninstall) {
  Head '연동 제거'
  try { if (Get-Printer -Name $PRINTER -ErrorAction SilentlyContinue) { Remove-Printer -Name $PRINTER -ErrorAction Stop; OK "가상 프린터 '$PRINTER' 제거" } else { Info '가상 프린터 없음' } } catch { Fail "프린터 제거 실패: $($_.Exception.Message)" }
  try { if (Get-PrinterPort -Name $portFile -ErrorAction SilentlyContinue) { Remove-PrinterPort -Name $portFile -ErrorAction Stop; OK '프린터 포트 제거' } } catch { Warn "포트 제거 실패(사용 중일 수 있음): $($_.Exception.Message)" }
  try { Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $RUNKEY -ErrorAction Stop; OK '인쇄 감시자 자동 시작 해제' } catch { Info '자동 시작 항목 없음' }
  $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\SendTo\PDF 분석기.lnk'
  if (Test-Path $lnk) { Remove-Item $lnk -Force -ErrorAction SilentlyContinue; OK "'보내기' 메뉴 항목 제거" } else { Info "'보내기' 항목 없음" }
  try { if (Get-NetFirewallRule -DisplayName $FWRULE -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -DisplayName $FWRULE -ErrorAction Stop; OK '방화벽 규칙 제거' } } catch {}
  Write-Host ''
  Say '제거를 마쳤습니다. (Ghostscript·한글·Office 등 외부 프로그램은 그대로 둡니다)' 'Cyan'
  if (-not $Quiet) { Read-Host '엔터를 누르면 닫힙니다' }
  exit 0
}

# ============================================================================
#  1. 가상 프린터 'PDF Editor'  — 어떤 앱에서든 '인쇄'로 이 앱에 문서 전달
# ============================================================================
$resPrinter = '건너뜀'
Head '1/6  가상 프린터 (인쇄 → 앱으로 접수)'
if ($Check) {
  if (Get-Printer -Name $PRINTER -ErrorAction SilentlyContinue) { OK "설치됨 ($PRINTER)"; $resPrinter = '설치됨' } else { Warn '미설치'; $resPrinter = '미설치' }
} else {
  try {
    if (-not (Test-Path $portDir)) { New-Item -ItemType Directory -Path $portDir -Force | Out-Null }
    if (-not (Get-PrinterDriver -Name $DRIVER -ErrorAction SilentlyContinue)) {
      Warn "'$DRIVER' 드라이버가 없습니다 — Windows 기능에서 'Microsoft Print to PDF'를 켜 주세요."
      $resPrinter = '드라이버 없음'
    } else {
      if (-not (Get-PrinterPort -Name $portFile -ErrorAction SilentlyContinue)) {
        Add-PrinterPort -Name $portFile -ErrorAction Stop
      }
      if (-not (Get-Printer -Name $PRINTER -ErrorAction SilentlyContinue)) {
        Add-Printer -Name $PRINTER -DriverName $DRIVER -PortName $portFile -ErrorAction Stop
        OK "가상 프린터 '$PRINTER' 설치"
      } else {
        OK "가상 프린터 '$PRINTER' 이미 설치됨"
      }
      Info "접수 폴더: $portDir"
      $resPrinter = '설치됨'
    }
  } catch { Fail "프린터 설치 실패: $($_.Exception.Message)"; $resPrinter = '실패' }
}

# ============================================================================
#  2. 인쇄 로그 활성화 — 접수 문서의 '원래 이름' 복구에 사용
# ============================================================================
$resLog = '건너뜀'
Head '2/6  인쇄 로그 (접수 문서의 원래 이름 복구)'
$logOn = $false
try { $logOn = (Get-WinEvent -ListLog $PRINTLOG -ErrorAction Stop).IsEnabled } catch {}
if ($Check) {
  if ($logOn) { OK '활성화됨'; $resLog = '활성' } else { Warn '비활성 (문서명 대신 인쇄접수_시각 으로 열림)'; $resLog = '비활성' }
} elseif ($logOn) {
  OK '이미 활성화되어 있습니다'; $resLog = '활성'
} else {
  try {
    wevtutil sl $PRINTLOG /e:true /ms:4194304
    $logOn = (Get-WinEvent -ListLog $PRINTLOG -ErrorAction SilentlyContinue).IsEnabled
    if ($logOn) { OK '인쇄 완료 로그 활성화 (문서명 기록 시작)'; $resLog = '활성' }
    else { Warn '활성화되지 않았습니다 — 앱이 작업 큐 감시로 대체 동작합니다'; $resLog = '비활성' }
  } catch { Warn "로그 활성화 실패: $($_.Exception.Message)"; $resLog = '비활성' }
}

# ============================================================================
#  3. 인쇄 감시자 자동 시작 — 앱이 꺼져 있어도 인쇄가 오면 앱을 실행
# ============================================================================
$resWatch = '건너뜀'
Head '3/6  인쇄 감시자 (앱이 꺼져 있어도 자동 실행)'
if ($Check) {
  $v = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $RUNKEY -ErrorAction SilentlyContinue)
  if ($v) { OK '등록됨'; $resWatch = '등록됨' } else { Warn '미등록'; $resWatch = '미등록' }
} elseif (-not $appExe) {
  Warn '앱 실행 파일을 찾지 못해 건너뜁니다 (앱을 한 번 실행하면 자동 등록됩니다)'
  $resWatch = '건너뜀'
} else {
  try {
    if (-not (Test-Path $portDir)) { New-Item -ItemType Directory -Path $portDir -Force | Out-Null }
    $watchPs = Join-Path $portDir 'print-watch.ps1'
    $procName = [IO.Path]::GetFileNameWithoutExtension($appExe)
    $body = @'
# PDF Editor 인쇄 감시 — 인쇄 결과가 도착하면 앱을 실행한다 (설치 스크립트 생성)
$m = New-Object System.Threading.Mutex($false, 'PDFEditorPrintWatch')
if (-not $m.WaitOne(0)) { exit }
$dir = '__DIR__'
$exe = '__EXE__'
$fsw = New-Object System.IO.FileSystemWatcher $dir, '*.pdf'
$fsw.EnableRaisingEvents = $true
while ($true) {
  $r = $fsw.WaitForChanged([System.IO.WatcherChangeTypes]'Created, Changed', 15000)
  if (-not $r.TimedOut) {
    Start-Sleep -Milliseconds 2000
    if (-not (Get-Process -Name '__PROC__' -ErrorAction SilentlyContinue)) {
      Start-Process -FilePath $exe
    }
  }
}
'@
    $body = $body.Replace('__DIR__', $portDir.Replace("'", "''"))
    $body = $body.Replace('__EXE__', $appExe.Replace("'", "''"))
    $body = $body.Replace('__PROC__', $procName.Replace("'", "''"))
    Set-Content -Path $watchPs -Value $body -Encoding utf8
    $cmd = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchPs`""
    New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $RUNKEY -Value $cmd -PropertyType String -Force | Out-Null
    OK '로그온 시 인쇄 감시자 자동 시작 등록'
    $resWatch = '등록됨'
  } catch { Warn "감시자 등록 실패: $($_.Exception.Message)"; $resWatch = '실패' }
}

# ============================================================================
#  4. 탐색기 '보내기' 메뉴 — 문서 우클릭 → 보내기 → PDF 분석기
# ============================================================================
$resSendTo = '건너뜀'
Head "4/6  탐색기 '보내기' 메뉴"
$lnkPath = Join-Path $env:APPDATA 'Microsoft\Windows\SendTo\PDF 분석기.lnk'
if ($Check) {
  if (Test-Path $lnkPath) { OK '등록됨'; $resSendTo = '등록됨' } else { Warn '미등록 (앱 첫 실행 시 자동 등록)'; $resSendTo = '미등록' }
} elseif (-not $appExe) {
  Warn '앱 실행 파일을 찾지 못해 건너뜁니다 (앱을 한 번 실행하면 자동 등록됩니다)'
} else {
  try {
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($lnkPath)
    $sc.TargetPath = $appExe
    $sc.Description = 'PDF 분석기로 열기'
    $sc.Save()
    OK "'보내기 → PDF 분석기' 등록"
    $resSendTo = '등록됨'
  } catch { Warn "등록 실패: $($_.Exception.Message)"; $resSendTo = '실패' }
}

# ============================================================================
#  5. Ghostscript — 프린터 잉크 판정 · 폰트 아웃라인화에 필요
# ============================================================================
$resGs = '미설치'
Head '5/6  Ghostscript (잉크 판정 · 폰트 아웃라인화)'
function Find-Gs {
  $c = Get-Command gswin64c.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $root = 'C:\Program Files\gs'
  if (Test-Path $root) {
    $v = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if ($v) {
      $exe = Join-Path $v.FullName 'bin\gswin64c.exe'
      if (Test-Path $exe) { return $exe }
    }
  }
  return $null
}
$gs = Find-Gs
if ($gs) {
  OK "설치됨: $gs"
  $resGs = '설치됨'
} elseif ($Check) {
  Warn '미설치 — 잉크 판정·폰트 아웃라인화 기능이 동작하지 않습니다'
} else {
  # ① 같은 폴더에 설치 파일(gs*.exe)이 있으면 그것으로 조용히 설치
  $local = Get-ChildItem -Path $PSScriptRoot -Filter 'gs*w64.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $local) { $local = Get-ChildItem -Path $PSScriptRoot -Filter 'gs*.exe' -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $EXENAME } | Select-Object -First 1 }
  if ($local) {
    Info "동봉된 설치 파일 사용: $($local.Name)"
    try { Start-Process -FilePath $local.FullName -ArgumentList '/S' -Wait; $gs = Find-Gs } catch { Warn "설치 실행 실패: $($_.Exception.Message)" }
  }
  # ② winget으로 설치 (인터넷 다운로드 — 사용자 확인 후)
  if (-not $gs) {
    $wg = Get-Command winget -ErrorAction SilentlyContinue
    if ($wg) {
      Info 'Ghostscript가 없습니다. winget으로 설치할 수 있습니다(인터넷에서 내려받습니다).'
      if (Ask '지금 설치할까요?' $true) {
        try {
          winget install --id ArtifexSoftware.GhostScript -e --accept-package-agreements --accept-source-agreements
          $gs = Find-Gs
        } catch { Warn "winget 설치 실패: $($_.Exception.Message)" }
      }
    }
  }
  if ($gs) { OK "설치 완료: $gs"; $resGs = '설치됨' }
  else {
    Warn '설치되지 않았습니다 — https://ghostscript.com/releases/gsdnld.html 에서 64bit 버전을 설치하세요.'
    Warn '(없어도 나머지 기능은 정상 동작합니다. 잉크 판정·폰트 아웃라인화만 비활성)'
  }
}

# ============================================================================
#  6. 방화벽 (모바일 연동 서버를 쓸 때만)
# ============================================================================
$resFw = '건너뜀'
Head '6/6  모바일 연동 방화벽 (선택)'
$fwExists = $null
try { $fwExists = Get-NetFirewallRule -DisplayName $FWRULE -ErrorAction SilentlyContinue } catch {}
if ($Check) {
  if ($fwExists) { OK '허용됨'; $resFw = '허용됨' } else { Info '미설정 (모바일 연동을 쓰지 않으면 불필요)'; $resFw = '미설정' }
} elseif ($fwExists) {
  OK '이미 허용되어 있습니다'; $resFw = '허용됨'
} else {
  $doFw = $Firewall
  if (-not $doFw) { $doFw = Ask "휴대폰에서 이 PC로 문서를 보내는 기능을 쓰시나요? (TCP $FWPORT 허용)" $false }
  if ($doFw) {
    try {
      New-NetFirewallRule -DisplayName $FWRULE -Direction Inbound -Action Allow -Protocol TCP -LocalPort $FWPORT -Profile Private -ErrorAction Stop | Out-Null
      OK "사설 네트워크에서 TCP $FWPORT 허용"
      $resFw = '허용됨'
    } catch { Warn "방화벽 설정 실패: $($_.Exception.Message)" }
  } else { Info '건너뜁니다 (나중에 -Firewall 옵션으로 설정 가능)' }
}

# ============================================================================
#  문서 변환용 외부 프로그램 감지 (설치 대상 아님 — 있으면 그 형식이 열림)
# ============================================================================
Head '문서 변환 프로그램 감지 (설치 대상 아님)'
function Test-Com($progId) {
  try {
    $o = New-Object -ComObject $progId -ErrorAction Stop
    try { [Runtime.InteropServices.Marshal]::ReleaseComObject($o) | Out-Null } catch {}
    return $true
  } catch { return $false }
}
$coms = @(
  @{ n = '한글 (HWP·HWPX)';        id = 'HWPFrame.HwpObject' },
  @{ n = 'MS Word (DOC·DOCX)';     id = 'Word.Application' },
  @{ n = 'MS Excel (XLS·XLSX)';    id = 'Excel.Application' },
  @{ n = 'MS PowerPoint (PPT·PPTX)'; id = 'PowerPoint.Application' },
  @{ n = 'Photoshop (PSD)';        id = 'Photoshop.Application' },
  @{ n = 'InDesign (INDD)';        id = 'InDesign.Application' }
)
foreach ($c in $coms) {
  if (Test-Com $c.id) { OK "$($c.n) — 변환 가능" } else { Info "$($c.n) — 없음 (해당 형식만 열 수 없음)" }
}
Info 'AI(일러스트레이터) 파일은 별도 프로그램 없이 바로 열립니다.'

# ============================================================================
#  요약
# ============================================================================
Write-Host ''
Say '═══════════════════════════════════════════════════════════' 'Cyan'
Say '  설치 요약' 'Cyan'
Say '═══════════════════════════════════════════════════════════' 'Cyan'
Write-Host ("  가상 프린터        : {0}" -f $resPrinter)
Write-Host ("  인쇄 로그(문서명)  : {0}" -f $resLog)
Write-Host ("  인쇄 감시자        : {0}" -f $resWatch)
Write-Host ("  보내기 메뉴        : {0}" -f $resSendTo)
Write-Host ("  Ghostscript        : {0}" -f $resGs)
Write-Host ("  모바일 방화벽      : {0}" -f $resFw)
Write-Host ''
if (-not $Check) {
  Say '이제 앱을 실행하면 모든 기능을 쓸 수 있습니다.' 'Green'
  Say "다른 앱에서 인쇄 → 프린터 '$PRINTER' 선택 → 이 앱으로 문서가 접수됩니다." 'Gray'
}
if (-not $Quiet) { Write-Host ''; Read-Host '엔터를 누르면 닫힙니다' }
