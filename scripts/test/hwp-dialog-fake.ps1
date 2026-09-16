# hwp-dialog-watch.test.ps1가 띄우는 가짜 대화상자 (가장 왼쪽 모니터, WPF — 한글 보안 창과 같은 구조)
# 사용: powershell -STA -File hwp-dialog-fake.ps1 -Scenario <이름> -Result <결과파일>
# 누른 버튼은 "<창>:<버튼>" 한 줄로 결과 파일에 남긴다. 20초 뒤 스스로 닫힌다.
param([string]$Scenario, [string]$Result)
Add-Type -AssemblyName PresentationFramework, System.Windows.Forms
$L = [System.Windows.Forms.Screen]::AllScreens | Sort-Object { $_.Bounds.X } | Select-Object -First 1
$bx = $L.WorkingArea.X + 40; $by = $L.WorkingArea.Y + 60

function New-Dlg([string]$tag, [string[]]$lines, [string[]]$buttons, [int]$x, [int]$y, [bool]$top) {
  $w = New-Object System.Windows.Window
  $w.Title = $tag; $w.Width = 420; $w.Height = 200; $w.Left = $x; $w.Top = $y
  $w.WindowStartupLocation = 'Manual'; $w.Topmost = $top; $w.ShowActivated = $false
  $sp = New-Object System.Windows.Controls.StackPanel
  foreach ($t in $lines) { $tb = New-Object System.Windows.Controls.TextBlock; $tb.Text = $t; $tb.Margin = '8,4,8,4'; [void]$sp.Children.Add($tb) }
  $row = New-Object System.Windows.Controls.StackPanel; $row.Orientation = 'Horizontal'; $row.Margin = '8'
  foreach ($b in $buttons) {
    $btn = New-Object System.Windows.Controls.Button; $btn.Content = $b; $btn.Margin = '4'; $btn.Padding = '8,4,8,4'
    $btn.Add_Click({ param($s, $e) Add-Content -LiteralPath $Result -Value ("{0}:{1}" -f $s.Tag, $s.Content) -Encoding UTF8; [System.Windows.Window]::GetWindow($s).Close() }.GetNewClosure())
    $btn.Tag = $tag
    [void]$row.Children.Add($btn)
  }
  [void]$sp.Children.Add($row)
  $w.Content = $sp
  $w.Show()
  return $w
}
$SEC = '한글을 이용하여 위 파일에 접근하려는 시도가 있습니다.'
$SEC_BTNS = @('접근 허용(Y)', '모두 허용(N)', '허용 안 함(A)', '모두 안 함(C)')
$wins = @()
switch ($Scenario) {
  'mixed' {
    $wins += New-Dlg 'OURS'  @('D:\바탕화면\테스트문서.hwp', $SEC) $SEC_BTNS $bx $by $true
    $wins += New-Dlg 'DECOY' @('변경된 내용을 저장하시겠습니까?') @('예(Y)', '아니요(N)', '확인') ($bx + 440) $by $true
    $wins += New-Dlg 'OTHER' @('D:\바탕화면\남의문서.hwp', $SEC) $SEC_BTNS $bx ($by + 230) $true
  }
  'covered' {
    $wins += New-Dlg 'OURS' @('D:\바탕화면\테스트문서.hwp', $SEC) $SEC_BTNS $bx $by $false
    $cover = New-Object System.Windows.Window
    $cover.Title = 'COVER'; $cover.Width = 460; $cover.Height = 240; $cover.Left = $bx - 20; $cover.Top = $by - 20
    $cover.WindowStartupLocation = 'Manual'; $cover.Topmost = $true; $cover.ShowActivated = $false
    $cover.Add_MouseDown({ Add-Content -LiteralPath $Result -Value 'COVER:clicked' -Encoding UTF8 }.GetNewClosure())
    $cover.Background = 'Gray'
    $cover.Show(); $wins += $cover
  }
}
Set-Content -LiteralPath ($Result + '.ready') -Value $PID -Encoding ASCII
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(20)
$timer.Add_Tick({ foreach ($w in $wins) { try { $w.Close() } catch {} }; [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown() })
$timer.Start()
[System.Windows.Threading.Dispatcher]::Run()
