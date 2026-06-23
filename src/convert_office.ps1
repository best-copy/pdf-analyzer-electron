# MS Office (Word/Excel/PowerPoint) -> PDF conversion via Office COM automation
# Usage: powershell -File convert_office.ps1 -InPath <source> -OutPath <output.pdf>
# Success: exit 0 ; Failure: stderr message + exit 1
#
# NOTE: kept ASCII-only on purpose. main.js wraps the (English) error with a
#       Korean prefix, so no Korean literals are needed here and the file does
#       NOT require a UTF-8 BOM (unlike convert_hwp.ps1).
param(
  [Parameter(Mandatory=$true)][string]$InPath,
  [Parameter(Mandatory=$true)][string]$OutPath
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $InPath)) { Write-Error "source file not found: $InPath"; exit 1 }
if (Test-Path -LiteralPath $OutPath) { Remove-Item -LiteralPath $OutPath -Force }

$ext = [System.IO.Path]::GetExtension($InPath).ToLowerInvariant()
$app = $null

try {
  switch -Regex ($ext) {

    '^\.docx?$' {
      # Word: ExportAsFixedFormat, wdExportFormatPDF = 17
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false
      $app.DisplayAlerts = 0   # wdAlertsNone
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
      $app = New-Object -ComObject Excel.Application
      $app.Visible = $false
      $app.DisplayAlerts = $false
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
      $app = New-Object -ComObject PowerPoint.Application
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

  if ($app) {
    $app.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
    $app = $null
  }

  if (-not (Test-Path -LiteralPath $OutPath)) { Write-Error "PDF was not created"; exit 1 }
  exit 0
}
catch {
  try { if ($app) { $app.Quit() } } catch {}
  Write-Error $_.Exception.Message
  exit 1
}
