# MS Office (Word/Excel/PowerPoint) -> PDF conversion via Office COM automation
# Usage: powershell -File convert_office.ps1 -InPath <source> -OutPath <output.pdf>
# Success: exit 0 ; Failure: stderr message + exit 1
#
# NOTE: kept ASCII-only on purpose. main.js wraps the (English) error with a
#       Korean prefix, so no Korean literals are needed here and the file does
#       NOT require a UTF-8 BOM (unlike convert_hwp.ps1).
#
# Safety:
#   - Macros are force-disabled before opening (AutomationSecurity = 3). COM-started Office
#     defaults to "enable all macros", and documents also arrive from the remote (phone) server.
#   - If COM attaches to an Office app the user already has open (PowerPoint is single-instance),
#     we do not quit it or change its visibility/alerts - only the document we opened is closed.
#   - Processes this script starts are printed as "COMPID:<pid>" so main.js can kill exactly
#     those if the conversion times out.
param(
  [Parameter(Mandatory=$true)][string]$InPath,
  [Parameter(Mandatory=$true)][string]$OutPath
)
$ErrorActionPreference = "Stop"

function Get-ProcIds([string[]]$names) { @(Get-Process -Name $names -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
function Report-NewProcs([string[]]$names, $before) {
  $new = @(Get-ProcIds $names | Where-Object { $before -notcontains $_ })
  foreach ($id in $new) { [Console]::Out.WriteLine("COMPID:$id") }
  [Console]::Out.Flush()
  return ($new.Count -gt 0)
}

if (-not (Test-Path -LiteralPath $InPath)) { Write-Error "source file not found: $InPath"; exit 1 }
if (Test-Path -LiteralPath $OutPath) { Remove-Item -LiteralPath $OutPath -Force }

$ext = [System.IO.Path]::GetExtension($InPath).ToLowerInvariant()
$app = $null
$launched = $false

function Quit-IfOurs {
  if ($script:app -and $script:launched) { try { $script:app.Quit() } catch {} }
  if ($script:app) { try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($script:app) | Out-Null } catch {} }
  $script:app = $null
}

try {
  switch -Regex ($ext) {

    '^\.docx?$' {
      # Word: ExportAsFixedFormat, wdExportFormatPDF = 17
      $names = @('WINWORD')
      $before = Get-ProcIds $names
      $app = New-Object -ComObject Word.Application
      $launched = Report-NewProcs $names $before
      if ($launched) { $app.Visible = $false; $app.DisplayAlerts = 0 }   # wdAlertsNone
      try { $app.AutomationSecurity = 3 } catch {}                         # msoAutomationSecurityForceDisable
      # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
      $doc = $app.Documents.Open($InPath, $false, $true, $false)
      try {
        $doc.ExportAsFixedFormat($OutPath, 17)
      } finally {
        $doc.Close($false)
      }
      break
    }

    '^\.xlsx?$' {
      # Excel: Workbook.ExportAsFixedFormat(xlTypePDF = 0)
      $names = @('EXCEL')
      $before = Get-ProcIds $names
      $app = New-Object -ComObject Excel.Application
      $launched = Report-NewProcs $names $before
      if ($launched) { $app.Visible = $false; $app.DisplayAlerts = $false }
      try { $app.AutomationSecurity = 3 } catch {}                         # msoAutomationSecurityForceDisable
      # Open(FileName, UpdateLinks, ReadOnly)
      $wb = $app.Workbooks.Open($InPath, 0, $true)
      try {
        $wb.ExportAsFixedFormat(0, $OutPath)
      } finally {
        $wb.Close($false)
      }
      break
    }

    '^\.pptx?$' {
      # PowerPoint: Presentation.SaveAs(ppSaveAsPDF = 32)
      # PowerPoint.Application.Visible cannot be set $false, so open windowless.
      $names = @('POWERPNT')
      $before = Get-ProcIds $names
      $app = New-Object -ComObject PowerPoint.Application
      $launched = Report-NewProcs $names $before
      try { $app.AutomationSecurity = 3 } catch {}                         # msoAutomationSecurityForceDisable
      # Open(FileName, ReadOnly, Untitled, WithWindow) -- msoTrue=-1 / msoFalse=0
      $pres = $app.Presentations.Open($InPath, -1, 0, 0)
      try {
        $pres.SaveAs($OutPath, 32)
      } finally {
        $pres.Close()
      }
      break
    }

    default {
      Write-Error "unsupported office format: $ext"
      exit 1
    }
  }

  Quit-IfOurs

  if (-not (Test-Path -LiteralPath $OutPath)) { Write-Error "PDF was not created"; exit 1 }
  exit 0
}
catch {
  $msg = $_.Exception.Message
  Quit-IfOurs
  Write-Error $msg
  exit 1
}
