# PDF 분석기 — 업데이트 기능이 없는 옛 버전(3.8 이하)을 새 버전으로 덮어쓰기 (make-full-dist.js가 zip에 넣는다)
#   · 같은 폴더의 app\ = 새 resources\app 전체, root\ = 실행 폴더에 둘 스크립트
#   · 설치 폴더 찾기: 인자 → '보내기' 바로 가기(PDF 분석기.lnk) → 실행 중인 앱 → 폴더 고르기 창
#   · 원래 resources\app은 resources\app.bak-<옛 버전>-<시각>으로 남긴다(되돌리기 = 이름을 다시 바꾸면 끝)
#   · 설정·작업 기록은 %APPDATA%에 있어 그대로 남는다
param([string]$Dir = '')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exeName = 'PDF 분석기.exe'
$newApp = Join-Path $here 'app'
$newRoot = Join-Path $here 'root'
$newVer = (Get-Content (Join-Path $newApp 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Done($code) { Write-Host ''; Read-Host '끝내려면 Enter' | Out-Null; exit $code }

Say "PDF 분석기 업데이트 → $newVer (정식판 · 체험 키 없이 기한 없이)" 'Cyan'
Say ''
if (-not (Test-Path (Join-Path $newApp 'main.js'))) { Say "✘ 업데이트 파일이 온전하지 않습니다 — zip을 모두 푼 뒤 다시 실행하세요." 'Red'; Done 1 }

function Find-Install {
  if ($Dir -and (Test-Path -LiteralPath (Join-Path $Dir $exeName))) { return $Dir }
  $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\SendTo\PDF 분석기.lnk'
  if (Test-Path -LiteralPath $lnk) {
    try { $t = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).TargetPath; if ($t -and (Test-Path -LiteralPath $t)) { return (Split-Path -Parent $t) } } catch {}
  }
  $p = Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -like "*\$exeName" } catch { $false } } | Select-Object -First 1
  if ($p) { return (Split-Path -Parent $p.Path) }
  Add-Type -AssemblyName System.Windows.Forms
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = "'PDF 분석기.exe'가 있는 폴더를 고르세요"
  if ($d.ShowDialog() -eq 'OK' -and (Test-Path -LiteralPath (Join-Path $d.SelectedPath $exeName))) { return $d.SelectedPath }
  return $null
}
$target = Find-Install
if (-not $target) { Say "✘ 'PDF 분석기.exe'가 있는 폴더를 찾지 못했습니다." 'Red'; Done 1 }
$exe = Join-Path $target $exeName
$app = Join-Path $target 'resources\app'
$oldVer = '?'
try { $oldVer = (Get-Content (Join-Path $app 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}
Say "설치 폴더: $target"
Say "지금 버전: $oldVer"
Say ''

# 쓰기 권한 — Program Files 등이면 관리자 권한으로 다시 실행
try { $probe = Join-Path $target ('.wtest_' + [guid]::NewGuid().ToString('N')); [IO.File]::WriteAllText($probe, 'x'); Remove-Item -LiteralPath $probe -Force }
catch {
  Say '이 폴더에 쓰려면 관리자 권한이 필요합니다 — 권한 창이 뜨면 [예]를 누르세요.' 'Yellow'
  Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($MyInvocation.MyCommand.Path)`"", '-Dir', "`"$target`"")
  exit 0
}

# 앱이 켜져 있으면 닫게 한다(같은 실행 파일만)
while ($true) {
  $run = Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -eq $exe } catch { $false } }
  if (-not $run) { break }
  Say 'PDF 분석기가 켜져 있습니다. 작업을 저장하고 앱을 닫은 뒤 Enter를 누르세요. (강제로 끄려면 K + Enter)' 'Yellow'
  $k = Read-Host
  if ($k -match '^[kK]') { $run | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
}

# 바꾸기 — 원래 폴더는 이름만 바꿔 남기고, 새 폴더를 복사. 실패하면 되돌린다
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = "$app.bak-$oldVer-$stamp"
try {
  if (Test-Path -LiteralPath $app) { Rename-Item -LiteralPath $app -NewName (Split-Path -Leaf $bak) }
  Say '새 버전 복사 중… (1분 정도)'
  Copy-Item -LiteralPath $newApp -Destination $app -Recurse -Force
  if (-not (Test-Path -LiteralPath (Join-Path $app 'full-license.dat'))) { throw '정식판 표시 파일이 복사되지 않았습니다' }
} catch {
  Say "✘ 복사 실패: $($_.Exception.Message)" 'Red'
  try { if (Test-Path -LiteralPath $app) { Remove-Item -LiteralPath $app -Recurse -Force } } catch {}
  try { if (Test-Path -LiteralPath $bak) { Rename-Item -LiteralPath $bak -NewName 'app' } } catch {}
  Say '원래대로 되돌렸습니다. 앱이 완전히 닫혔는지 확인하고 다시 실행하세요.' 'Yellow'
  Done 1
}
if (Test-Path -LiteralPath $newRoot) { Get-ChildItem -LiteralPath $newRoot -File | ForEach-Object { try { Copy-Item -LiteralPath $_.FullName -Destination $target -Force } catch {} } }

Say ''
Say "✔ 업데이트 완료: $oldVer → $newVer (정식판 — 체험 키·사용 기한 없이 저장·출력)" 'Green'
Say "   옛 버전은 '$(Split-Path -Leaf $bak)' 폴더로 남겨 두었습니다(확인 뒤 지워도 됩니다)."
Say '   설정·프리셋·작업 기록은 그대로입니다. 다음부터는 앱의 창 메뉴(Alt) Help → 업데이트 적용으로 올릴 수 있습니다.'
Say ''
$a = Read-Host '지금 앱을 켤까요? (Enter = 켜기, N = 그냥 끝내기)'
if ($a -notmatch '^[nN]') { Start-Process -FilePath $exe }
exit 0
