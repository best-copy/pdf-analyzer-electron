# Adobe (Photoshop .psd / InDesign .indd / Illustrator .ai) -> PDF via COM automation
# Usage: powershell -File convert_adobe.ps1 -InPath <source> -OutPath <output.pdf>
# Success: exit 0 ; Failure: stderr message + exit 1
#
# NOTE: ASCII-only on purpose (like convert_office.ps1) so NO UTF-8 BOM is needed.
#       main.js wraps the English error with a Korean prefix.
#
# .ai: PDF-compatible .ai files are real PDFs and are handled directly by the
#      renderer WITHOUT launching Illustrator. This script's .ai branch is only a
#      fallback for non-PDF-compatible .ai (Illustrator COM, may be unavailable).
param(
  [Parameter(Mandatory=$true)][string]$InPath,
  [Parameter(Mandatory=$true)][string]$OutPath
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $InPath)) { Write-Error "source file not found: $InPath"; exit 1 }
if (Test-Path -LiteralPath $OutPath) { Remove-Item -LiteralPath $OutPath -Force }

$ext  = [System.IO.Path]::GetExtension($InPath).ToLowerInvariant()
$full = (Resolve-Path -LiteralPath $InPath).Path
$app  = $null
$isIndd = $false

try {
  switch ($ext) {

    '.psd' {
      # Photoshop: open then SaveAs PDF (as copy, leave source untouched)
      $app = New-Object -ComObject Photoshop.Application
      try { $app.DisplayDialogs = 3 } catch {}        # psDisplayNoDialogs
      $doc = $app.Open($full)
      try {
        $opts = New-Object -ComObject Photoshop.PDFSaveOptions
        $doc.SaveAs($OutPath, $opts, $true)            # asCopy = true
      } finally {
        try { $doc.Close(2) } catch {}                 # psDoNotSaveChanges
      }
      break
    }

    '.indd' {
      # InDesign: open then Export to PDF using the first export preset
      $isIndd = $true
      $app = New-Object -ComObject InDesign.Application
      try { $app.ScriptPreferences.UserInteractionLevel = 1699311169 } catch {}  # idNeverInteract
      $doc = $app.Open($full)
      try {
        $preset = $null
        try { $preset = $app.PDFExportPresets.Item("[High Quality Print]") } catch {}
        if (-not $preset) { $preset = $app.PDFExportPresets.Item(1) }   # locale-independent fallback
        # 1952403524 = idExportFormat.pdfType ("Adobe PDF (Print)")
        $doc.Export(1952403524, $OutPath, $false, $preset)
      } finally {
        try { $doc.Close(1852776480) } catch {}        # idSaveOptions.no
      }
      break
    }

    '.ai' {
      # Fallback only: non-PDF-compatible .ai. Illustrator COM may be unavailable
      # (newer versions dropped the COM server) -> give an actionable error.
      $progids = @('Illustrator.Application.29','Illustrator.Application.28','Illustrator.Application')
      foreach ($p in $progids) { try { $app = New-Object -ComObject $p; break } catch {} }
      if (-not $app) {
        Write-Error "Illustrator COM not available. Re-save the .ai with 'Create PDF Compatible File' enabled."
        exit 1
      }
      try { $app.UserInteractionLevel = -1 } catch {}  # aiDontDisplayAlerts
      $doc = $app.Open($full)
      try {
        $opts = New-Object -ComObject Illustrator.PDFSaveOptions
        $doc.SaveAs($OutPath, $opts)
      } finally {
        try { $doc.Close(2) } catch {}                 # aiDoNotSaveChanges
      }
      break
    }

    default { Write-Error "unsupported adobe format: $ext"; exit 1 }
  }

  if ($app) {
    try { if ($isIndd) { $app.Quit(1852776480) } else { $app.Quit() } } catch {}
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
    $app = $null
  }

  if (-not (Test-Path -LiteralPath $OutPath)) { Write-Error "PDF was not created"; exit 1 }
  exit 0
}
catch {
  try { if ($app) { if ($isIndd) { $app.Quit(1852776480) } else { $app.Quit() } } } catch {}
  Write-Error $_.Exception.Message
  exit 1
}
