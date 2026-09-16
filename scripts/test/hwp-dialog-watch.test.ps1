# 한글 보안창 워처 검증 — convert_hwp.ps1의 C# 코드를 그대로 떼어 가짜 대화상자(가장 왼쪽 모니터)에 돌린다.
#   실행: powershell -ExecutionPolicy Bypass -File scripts/test/hwp-dialog-watch.test.ps1
# 회귀: 워처가 한글 프로세스의 아무 창에서나 '모두 허용 > 허용 > 확인/예/계속'을 눌러, 사용자가 켜 둔 한글의
#       "저장하시겠습니까? [예]"·다른 파일 보안 창까지 누를 수 있었다. 가려진 버튼 좌표에 진짜 클릭을 보내 뒤 창을 눌렀다.
# ※ 한글 문자열 포함 — UTF-8 BOM 필수
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$src = Get-Content -LiteralPath (Join-Path $root 'src\convert_hwp.ps1') -Raw -Encoding UTF8
$m = [regex]::Match($src, '-TypeDefinition @"\r?\n([\s\S]*?)\r?\n"@')
if (-not $m.Success) { Write-Host '  ✘ convert_hwp.ps1에서 C# 코드를 찾지 못함'; exit 1 }
$fw = [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
Add-Type -ReferencedAssemblies @('System.dll', (Join-Path $fw 'WPF\UIAutomationClient.dll'), (Join-Path $fw 'WPF\UIAutomationTypes.dll'), (Join-Path $fw 'WPF\WindowsBase.dll')) -TypeDefinition $m.Groups[1].Value

$pass = 0; $fail = 0
function Ck([string]$name, [bool]$ok, $info) {
  if ($ok) { $script:pass++; Write-Host "  ✔ $name" } else { $script:fail++; Write-Host "  ✘ $name  $info" }
}
$fake = Join-Path $PSScriptRoot 'hwp-dialog-fake.ps1'
function Start-Fake([string]$scenario) {
  $res = Join-Path $env:TEMP ("hwpdlg_{0}_{1}.txt" -f $scenario, [guid]::NewGuid().ToString('N').Substring(0, 6))
  $p = Start-Process powershell -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', "`"$fake`"", '-Scenario', $scenario, '-Result', "`"$res`"") -PassThru -WindowStyle Hidden
  $t = Get-Date
  while (-not (Test-Path ($res + '.ready')) -and ((Get-Date) - $t).TotalSeconds -lt 15) { Start-Sleep -Milliseconds 100 }
  Start-Sleep -Milliseconds 1200   # 창이 그려질 때까지
  return @{ Proc = $p; Result = $res }
}
function Clicks($f) { if (Test-Path $f.Result) { @(Get-Content -LiteralPath $f.Result -Encoding UTF8) } else { @() } }
function Stop-Fake($f) { try { Stop-Process -Id $f.Proc.Id -Force -ErrorAction SilentlyContinue } catch {}; Remove-Item ($f.Result), ($f.Result + '.ready') -ErrorAction SilentlyContinue }
function Run-Watch([string]$proc, [int[]]$own, [string[]]$keys, [bool]$attached, [int]$rounds) {
  $out = @()
  for ($i = 0; $i -lt $rounds; $i++) { $r = [HwpDlg]::DismissOnce($proc, $own, $keys, $attached); if ($r) { $out += $r }; Start-Sleep -Milliseconds 400 }
  return $out
}
$keys = @('테스트문서.hwp', '테스트문서')

Write-Host "`n[1] 사용자가 켜 둔 한글에 붙은 경우 — 파일 이름이 맞는 보안 창만, '접근 허용'으로"
$f = Start-Fake 'mixed'
$r = Run-Watch 'powershell' @() $keys $true 6
$c = Clicks $f
Ck '우리 파일 보안 창만 눌림' (($c -join '|') -eq 'OURS:접근 허용(Y)') ($c -join '|')
Ck "켜져 있던 한글에서는 '모두 허용'을 누르지 않음" (-not ($c -match '모두 허용')) ($c -join '|')
Ck "저장 확인 창(예/확인)은 건드리지 않음" (-not ($c -match 'DECOY')) ($c -join '|')
Ck '다른 파일의 보안 창은 건드리지 않음(파일 이름 불일치)' (-not ($c -match 'OTHER') -and ($r -contains 'no-match:file')) ($r -join '|')
Stop-Fake $f

Write-Host "`n[2] 우리가 새로 띄운 한글 — 그 프로세스의 보안 창은 파일 이름 없이도, '모두 허용'으로"
$f = Start-Fake 'mixed'
$r = Run-Watch 'Hwp' @($f.Proc.Id) @('없는파일') $false 6
$c = Clicks $f
Ck '보안 창 두 개 모두 모두 허용' ((@($c | Where-Object { $_ -match '모두 허용' }).Count -eq 2) -and ($c.Count -eq 2)) ($c -join '|')
Ck "저장 확인 창(예/확인)은 건드리지 않음" (-not ($c -match 'DECOY')) ($c -join '|')
Stop-Fake $f

Write-Host "`n[3] 한글이 아닌 프로세스·우리 것 아닌 번호 — 아무것도 누르지 않음"
$f = Start-Fake 'mixed'
$r = Run-Watch 'Hwp' @(999999) $keys $false 3
$c = Clicks $f
Ck '다른 프로그램의 같은 모양 창은 무시' ($c.Count -eq 0 -and $r.Count -eq 0) (($c + $r) -join '|')
Stop-Fake $f

Write-Host "`n[4] 보안 창이 다른 창에 가려진 경우 — 가린 창을 클릭하지 않음"
$f = Start-Fake 'covered'
$r = Run-Watch 'powershell' @() $keys $true 3
$c = Clicks $f
Ck '가려짐을 알아채고 누르지 않음' (($r -contains 'occluded') -and -not ($c -match 'COVER')) (($c + $r) -join '|')
Stop-Fake $f

Write-Host "`n  $pass 통과 · $fail 실패"
if ($fail) { exit 1 } else { exit 0 }
