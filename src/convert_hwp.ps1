# HWP/HWPX → PDF 변환 (한컴오피스 한글 COM 자동화)
# 사용: powershell -File convert_hwp.ps1 -InPath <원본> -OutPath <출력PDF>
# 성공 시 exit 0, 실패 시 stderr 메시지 + exit 1
#
# 권한(보안 승인) 대화상자 자동 처리:
#   한글 자동화 시 "한글을 이용하여 위 파일에 접근하려는 시도가 있습니다" 보안 창이 뜬다.
#   버튼: [접근 허용(Y)] [모두 허용(N)] [허용 안 함(A)] [모두 안 함(C)]
#   RegisterModule 로 1차 차단하고, 그래도 뜨는 창은 백그라운드 워처가
#   '모두 허용' > '접근 허용' > '확인/예' 우선순위로 자동 클릭한다.
#   ('허용 안 함 / 모두 안 함 / 취소' 계열은 절대 누르지 않는다)
#
# ※ 이 파일은 한글 문자열을 코드에 포함하므로 반드시 UTF-8 BOM 으로 저장할 것
#   (PowerShell 5.1 이 CP949 로 오인해 한글이 깨지면 파싱 오류 발생)
param(
  [Parameter(Mandatory=$true)][string]$InPath,
  [Parameter(Mandatory=$true)][string]$OutPath
)
$ErrorActionPreference = "Stop"
$hwp = $null
$watcher = $null

# ── 보안 대화상자 자동 승인 워처 (별도 잡: COM 호출이 블로킹돼도 독립 동작) ──
#   한글은 WPF 기반이라 다이얼로그 버튼이 Win32 버튼 핸들이 아니다.
#   → UI Automation(UIA)으로 버튼을 찾아 InvokePattern 으로 누른다(크로스 프로세스·포그라운드 불필요).
$watcherScript = {
  # UIAutomation 어셈블리는 단순 이름으로 참조 불가 → 런타임 디렉터리의 전체 경로로 참조
  $fw = [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
  $uiaC = Join-Path $fw 'WPF\UIAutomationClient.dll'
  $uiaT = Join-Path $fw 'WPF\UIAutomationTypes.dll'
  $wb   = Join-Path $fw 'WPF\WindowsBase.dll'
  Add-Type -ReferencedAssemblies @('System.dll',$uiaC,$uiaT,$wb) -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public class HwpDlg {
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
  struct POINT { public int X; public int Y; }
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;

  // WPF 버튼은 InvokePattern.Invoke()가 무효인 경우가 있어, 버튼의 실제 화면 좌표에
  // 진짜 마우스 클릭을 보낸 뒤 커서를 원위치로 복원한다.
  static bool ClickElement(AutomationElement el) {
    try {
      System.Windows.Point cp;
      if (!el.TryGetClickablePoint(out cp)) {
        cp = el.GetClickablePoint();
      }
      POINT old; GetCursorPos(out old);
      SetCursorPos((int)cp.X, (int)cp.Y);
      mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
      mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
      SetCursorPos(old.X, old.Y);
      return true;
    } catch { return false; }
  }

  // 한글 프로세스 창의 보안 대화상자에서 긍정 버튼을 우선순위대로 1개 클릭.
  // 누른 버튼 이름을 반환(없으면 null).
  public static string DismissOnce() {
    var root = AutomationElement.RootElement;
    var tops = root.FindAll(TreeScope.Children, Condition.TrueCondition);
    foreach (AutomationElement w in tops) {
      int pid; try { pid = w.Current.ProcessId; } catch { continue; }
      string pn = ""; try { pn = Process.GetProcessById(pid).ProcessName; } catch {}
      if (pn.IndexOf("Hwp", StringComparison.OrdinalIgnoreCase) < 0) continue;

      AutomationElementCollection btns;
      try { btns = w.FindAll(TreeScope.Descendants,
              new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)); }
      catch { continue; }

      AutomationElement target = null; string tname = null;
      // 1순위: 모두 허용
      foreach (AutomationElement b in btns) {
        string nm = ""; try { nm = b.Current.Name; } catch {}
        if (nm.Contains("모두 허용") || nm.Contains("모두허용")) { target = b; tname = nm; break; }
      }
      // 2순위: 접근 허용 / 허용 (단, '안 함'·'안함' 제외)
      if (target == null) foreach (AutomationElement b in btns) {
        string nm = ""; try { nm = b.Current.Name; } catch {}
        if (nm.Contains("허용") && !nm.Contains("안 함") && !nm.Contains("안함")) { target = b; tname = nm; break; }
      }
      // 3순위: 확인 / 예 / 계속 / 동의 (저장·기타 확인 대화상자 대비)
      if (target == null) foreach (AutomationElement b in btns) {
        string nm = ""; try { nm = b.Current.Name; } catch {}
        if ((nm.Contains("확인") || nm == "예" || nm.Contains("계속") || nm.Contains("동의")) && !nm.Contains("안")) { target = b; tname = nm; break; }
      }

      if (target != null) {
        if (ClickElement(target)) return tname;
      }
    }
    return null;
  }
}
"@
  $log = Join-Path $env:TEMP "hwp_dlg_watch.log"
  ("[{0}] watcher start" -f (Get-Date -Format HH:mm:ss)) | Out-File $log -Append -Encoding UTF8
  $deadline = (Get-Date).AddSeconds(150)
  while ((Get-Date) -lt $deadline) {
    try {
      $c = [HwpDlg]::DismissOnce()
      if ($c) { ("[{0}] clicked: {1}" -f (Get-Date -Format HH:mm:ss), $c) | Out-File $log -Append -Encoding UTF8 }
    } catch {}
    Start-Sleep -Milliseconds 300
  }
}

try {
  if (-not (Test-Path -LiteralPath $InPath)) { Write-Error "원본 파일 없음: $InPath"; exit 1 }

  # 대화상자 자동 승인 워처 시작
  try { $watcher = Start-Job -ScriptBlock $watcherScript } catch { $watcher = $null }

  $hwp = New-Object -ComObject HWPFrame.HwpObject
  # 보안 모듈 등록 — 자동화 시 '외부 접근' 보안 대화상자 1차 차단
  try { $hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule") | Out-Null } catch {}
  # 대화상자 자동 처리(무시) — 변환 중 모달이 떠서 멈추는 것 방지
  try { $hwp.SetMessageBoxMode(0x00020000) | Out-Null } catch {}

  # format "" → 확장자 자동감지 (HWP/HWPX 모두 처리)
  $hwp.Open($InPath, "", "")

  if (Test-Path -LiteralPath $OutPath) { Remove-Item -LiteralPath $OutPath -Force }

  $pset = $hwp.HParameterSet.HFileOpenSave
  $hwp.HAction.GetDefault("FileSaveAsPdf", $pset.HSet) | Out-Null
  $pset.filename = $OutPath
  $pset.Format   = "PDF"
  $hwp.HAction.Execute("FileSaveAsPdf", $pset.HSet) | Out-Null

  $hwp.Clear(1)
  $hwp.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($hwp) | Out-Null
  $hwp = $null

  if (-not (Test-Path -LiteralPath $OutPath)) { Write-Error "PDF 생성 실패"; exit 1 }
  exit 0
}
catch {
  try { if ($hwp) { $hwp.Quit() } } catch {}
  Write-Error $_.Exception.Message
  exit 1
}
finally {
  if ($watcher) { try { Stop-Job $watcher -ErrorAction SilentlyContinue; Remove-Job $watcher -Force -ErrorAction SilentlyContinue } catch {} }
}
