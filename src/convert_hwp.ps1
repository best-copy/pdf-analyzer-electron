# HWP/HWPX → PDF 변환 (한컴오피스 한글 COM 자동화)
# 사용: powershell -File convert_hwp.ps1 -InPath <원본> -OutPath <출력PDF>
# 성공 시 exit 0, 실패 시 stderr 메시지 + exit 1
#
# 권한(보안 승인) 대화상자 자동 처리:
#   한글 자동화 시 "한글을 이용하여 위 파일에 접근하려는 시도가 있습니다" 보안 창이 뜬다.
#   버튼: [접근 허용(Y)] [모두 허용(N)] [허용 안 함(A)] [모두 안 함(C)]
#   RegisterModule 로 1차 차단하고, 그래도 뜨는 창은 백그라운드 워처가 누른다.
#   ⚠ 사용자가 켜 둔 한글에 붙을 수 있으므로(한글은 단일 인스턴스) 아무 창이나 누르면 안 된다:
#     · 누르는 창은 '접근하려는 시도' 보안 창뿐 — 확인/예/계속 같은 다른 대화상자는 절대 누르지 않는다
#       (예전엔 3순위로 눌러 사용자의 "저장하시겠습니까? [예]"까지 누를 수 있었다)
#     · 우리가 새로 띄운 한글이면 그 프로세스의 보안 창만, 켜져 있던 한글이면 창 글자에
#       **변환 중인 파일 이름**이 있을 때만 누른다
#     · 켜져 있던 한글에서는 '모두 허용'이 아니라 '접근 허용'(이 파일만)
#     · 진짜 마우스 클릭이라(WPF 버튼은 Invoke가 무효) 그 좌표 맨 위가 그 버튼일 때만, 사용자가
#       마우스 버튼을 누르고 있지 않을 때만 누른다 — 다른 창에 가려져 있으면 엉뚱한 곳을 클릭한다
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
$launched = $false

# 이 스크립트가 **새로 띄운** 한글 프로세스 번호를 'COMPID:n'으로 먼저 알린다 — 변환이 시간 초과로 끊기면
# main.js가 그 번호만 정리한다(예전엔 PowerShell만 죽고 한글이 문서를 잡은 채 남았다).
# 사용자가 원래 켜 둔 한글에 붙었으면 번호가 없고, 그 한글은 끄지 않는다.
function Get-ProcIds([string[]]$names) { @(Get-Process -Name $names -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
function Report-NewProcs([string[]]$names, $before) {
  $new = @(Get-ProcIds $names | Where-Object { $before -notcontains $_ })
  foreach ($id in $new) { [Console]::Out.WriteLine("COMPID:$id") }
  [Console]::Out.Flush()
  return $new
}

# ── 보안 대화상자 워처 (별도 잡: COM 호출이 블로킹돼도 독립 동작) ──
#   한글은 WPF 기반이라 다이얼로그 버튼이 Win32 버튼 핸들이 아니다 → UI Automation(UIA)으로 찾는다.
#   C# 부분은 scripts/test/hwp-dialog-watch.test.ps1이 이 파일에서 그대로 떼어 가짜 대화상자로 검증한다.
$watcherScript = {
  param([int[]]$OwnPids, [string[]]$FileKeys, [bool]$Attached)
  # UIAutomation 어셈블리는 단순 이름으로 참조 불가 → 런타임 디렉터리의 전체 경로로 참조
  $fw = [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
  $uiaC = Join-Path $fw 'WPF\UIAutomationClient.dll'
  $uiaT = Join-Path $fw 'WPF\UIAutomationTypes.dll'
  $wb   = Join-Path $fw 'WPF\WindowsBase.dll'
  Add-Type -ReferencedAssemblies @('System.dll',$uiaC,$uiaT,$wb) -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public class HwpDlg {
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  struct POINT { public int X; public int Y; }
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;

  // 보안 창 문구 — '위 파일에 접근하려는 시도가 있습니다'
  static bool IsSecurityText(string s) {
    return s.Contains("접근하려는") || (s.Contains("접근") && s.Contains("시도"));
  }
  static string NameOf(AutomationElement e) { try { return e.Current.Name ?? ""; } catch { return ""; } }

  // el에서 위로 올라가 가장 가까운 창(Window) — 한글 본문 창 전체가 아니라 그 대화상자만 보려고
  static AutomationElement WindowOf(AutomationElement el) {
    var tw = TreeWalker.ControlViewWalker;
    var cur = el;
    while (cur != null && !Automation.Compare(cur, AutomationElement.RootElement)) {
      try { if (cur.Current.ControlType == ControlType.Window) return cur; } catch { return null; }
      try { cur = tw.GetParent(cur); } catch { return null; }
    }
    return null;
  }
  static bool IsInside(AutomationElement el, AutomationElement ancestor) {
    var tw = TreeWalker.ControlViewWalker;
    var cur = el;
    for (int i = 0; cur != null && i < 30; i++) {
      if (Automation.Compare(cur, ancestor)) return true;
      try { cur = tw.GetParent(cur); } catch { return false; }
    }
    return false;
  }

  // 대상 판정 결과 — 테스트가 이유를 확인할 수 있게 문자열로 돌려준다
  //   "clicked:<버튼>" · "occluded" · "user-mouse" · "no-match:<이유>" · null(보안 창 없음)
  // ownPids: 이 스크립트가 띄운 한글 프로세스(비면 이름으로 찾되 fileKeys 필수)
  // procName: 대상 프로세스 이름 조각(실사용 "Hwp")
  public static string DismissOnce(string procName, int[] ownPids, string[] fileKeys, bool attached) {
    var own = new HashSet<int>(ownPids ?? new int[0]);
    string last = null;
    var root = AutomationElement.RootElement;
    AutomationElementCollection tops;
    try { tops = root.FindAll(TreeScope.Children, Condition.TrueCondition); } catch { return null; }
    foreach (AutomationElement top in tops) {
      int pid; try { pid = top.Current.ProcessId; } catch { continue; }
      bool mine = own.Contains(pid);
      if (!mine) {
        string pn = ""; try { pn = Process.GetProcessById(pid).ProcessName; } catch {}
        if (pn.IndexOf(procName, StringComparison.OrdinalIgnoreCase) < 0) continue;
      }
      // 보안 문구가 있는 글자 → 그 글자가 속한 대화상자
      AutomationElementCollection texts;
      try { texts = top.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)); }
      catch { continue; }
      AutomationElement dlg = null;
      foreach (AutomationElement t in texts) {
        if (IsSecurityText(NameOf(t))) { dlg = WindowOf(t) ?? top; break; }
      }
      if (dlg == null && IsSecurityText(NameOf(top))) dlg = top;
      if (dlg == null) continue;

      // 대화상자 안의 모든 글자 — 파일 이름 확인용
      var all = new System.Text.StringBuilder(NameOf(dlg));
      try {
        foreach (AutomationElement t in dlg.FindAll(TreeScope.Descendants, Condition.TrueCondition)) {
          all.Append('\n').Append(NameOf(t));
          object vp;   // 경로를 입력칸(Edit)에 보여 주면 이름이 아니라 값에 있다
          try { if (t.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) all.Append('\n').Append(((ValuePattern)vp).Current.Value); } catch {}
        }
      } catch {}
      string text = all.ToString();
      bool keyHit = false;
      foreach (var k in fileKeys ?? new string[0]) if (!string.IsNullOrEmpty(k) && text.IndexOf(k, StringComparison.OrdinalIgnoreCase) >= 0) { keyHit = true; break; }
      // 우리가 띄운 한글이 아니면(사용자 한글) 파일 이름이 보여야 우리 것으로 본다
      if (!mine && !keyHit) { last = "no-match:file"; continue; }

      AutomationElementCollection btns;
      try { btns = dlg.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)); }
      catch { continue; }
      AutomationElement allowAll = null, allowOne = null;
      foreach (AutomationElement b in btns) {
        string nm = NameOf(b);
        if (nm.Contains("안 함") || nm.Contains("안함") || nm.Contains("취소")) continue;
        if (nm.Contains("모두 허용") || nm.Contains("모두허용")) allowAll = b;
        else if (nm.Contains("접근 허용") || nm.Contains("접근허용")) allowOne = b;
      }
      // 켜져 있던 한글에서는 이 파일만 허용(모두 허용은 사용자 한글의 이후 자동화까지 열어 준다)
      var target = attached ? (allowOne ?? null) : (allowAll ?? allowOne);
      if (target == null) { last = "no-match:button"; continue; }
      return Click(target, dlg);
    }
    return last;
  }

  static string Click(AutomationElement target, AutomationElement dlg) {
    // 가려진 버튼은 클릭 가능 좌표를 안 준다 → 버튼 가운데로 잡고 아래의 '맨 위 확인'이 가려짐을 가린다
    System.Windows.Point cp;
    try {
      if (!target.TryGetClickablePoint(out cp)) {
        var r = target.Current.BoundingRectangle;
        if (r.IsEmpty || r.Width <= 0) return "no-match:point";
        cp = new System.Windows.Point(r.X + r.Width / 2, r.Y + r.Height / 2);
      }
    } catch { return "no-match:point"; }
    if ((GetAsyncKeyState(0x01) & 0x8000) != 0 || (GetAsyncKeyState(0x02) & 0x8000) != 0) return "user-mouse";   // 사용자가 누르는 중
    // 그 좌표 맨 위가 정말 이 버튼(또는 그 안)인가 — 가려져 있으면 누르지 않고 앞으로 올려 달라고만 한다
    AutomationElement at = null;
    try { at = AutomationElement.FromPoint(cp); } catch {}
    if (at == null || !(IsInside(at, target))) {
      try { SetForegroundWindow(new IntPtr(dlg.Current.NativeWindowHandle)); } catch {}
      return "occluded";
    }
    POINT old; GetCursorPos(out old);
    SetCursorPos((int)cp.X, (int)cp.Y);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
    SetCursorPos(old.X, old.Y);
    return "clicked:" + NameOf(target);
  }
}
"@
  $log = Join-Path $env:TEMP "hwp_dlg_watch.log"
  ("[{0}] watcher start own={1} attached={2}" -f (Get-Date -Format HH:mm:ss), ($OwnPids -join ','), $Attached) | Out-File $log -Append -Encoding UTF8
  $deadline = (Get-Date).AddSeconds(150)
  $prev = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $c = [HwpDlg]::DismissOnce('Hwp', $OwnPids, $FileKeys, $Attached)
      if ($c -and $c -ne $prev) { ("[{0}] {1}" -f (Get-Date -Format HH:mm:ss), $c) | Out-File $log -Append -Encoding UTF8 }
      $prev = $c
    } catch {}
    Start-Sleep -Milliseconds 300
  }
}

try {
  if (-not (Test-Path -LiteralPath $InPath)) { Write-Error "원본 파일 없음: $InPath"; exit 1 }

  $hwpBefore = Get-ProcIds @('Hwp')
  $hwp = New-Object -ComObject HWPFrame.HwpObject
  $newPids = @(Report-NewProcs @('Hwp') $hwpBefore)
  $launched = $newPids.Count -gt 0

  # 대화상자 워처 — 누구의 한글인지 알고 난 뒤 시작한다(보안 창은 Open 때 뜬다)
  $keys = @([System.IO.Path]::GetFileName($InPath), [System.IO.Path]::GetFileNameWithoutExtension($InPath)) | Where-Object { $_ }
  $own = if ($launched) { [int[]]$newPids } else { [int[]]@() }
  try { $watcher = Start-Job -ScriptBlock $watcherScript -ArgumentList $own, ([string[]]$keys), (-not $launched) } catch { $watcher = $null }

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
  if ($launched) { $hwp.Quit() }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($hwp) | Out-Null
  $hwp = $null

  if (-not (Test-Path -LiteralPath $OutPath)) { Write-Error "PDF 생성 실패"; exit 1 }
  exit 0
}
catch {
  try { if ($hwp -and $launched) { $hwp.Quit() } } catch {}
  Write-Error $_.Exception.Message
  exit 1
}
finally {
  if ($watcher) { try { Stop-Job $watcher -ErrorAction SilentlyContinue; Remove-Job $watcher -Force -ErrorAction SilentlyContinue } catch {} }
}
