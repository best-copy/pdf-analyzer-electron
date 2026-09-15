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
#
# The user's own session is never disturbed:
#   Adobe apps are single-instance COM servers - if the app is already running, New-Object
#   attaches to the user's session. Then we do NOT quit the app (that used to close the user's
#   InDesign and discard unsaved work), we close only the document we opened, and we restore
#   the dialog settings we changed. If the same file is already open, it is exported as-is
#   and left open.
#   Processes this script starts are printed as "COMPID:<pid>" so main.js can kill exactly
#   those (and nothing the user started) if the conversion times out.
param(
  [Parameter(Mandatory=$true)][string]$InPath,
  [Parameter(Mandatory=$true)][string]$OutPath
)
$ErrorActionPreference = "Stop"

function Get-ProcIds([string[]]$names) { @(Get-Process -Name $names -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
# Print PIDs that appeared since $before; returns $true if we launched the app ourselves
function Report-NewProcs([string[]]$names, $before) {
  $new = @(Get-ProcIds $names | Where-Object { $before -notcontains $_ })
  foreach ($id in $new) { [Console]::Out.WriteLine("COMPID:$id") }
  [Console]::Out.Flush()
  return ($new.Count -gt 0)
}
# Document already open in the attached session (same full path), or $null
function Find-OpenDoc($app, [string]$fullPath) {
  try {
    foreach ($d in $app.Documents) {
      try {
        $p = [string]$d.FullName
        if ($p -and ([System.IO.Path]::GetFullPath($p) -ieq $fullPath)) { return $d }
      } catch {}
    }
  } catch {}
  return $null
}

if (-not (Test-Path -LiteralPath $InPath)) { Write-Error "source file not found: $InPath"; exit 1 }
if (Test-Path -LiteralPath $OutPath) { Remove-Item -LiteralPath $OutPath -Force }

$ext  = [System.IO.Path]::GetExtension($InPath).ToLowerInvariant()
$full = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $InPath).Path)
$app  = $null
$isIndd = $false
$launched = $false

function Quit-IfOurs {
  if ($script:app -and $script:launched) {
    try { if ($script:isIndd) { $script:app.Quit(1852776480) } else { $script:app.Quit() } } catch {}   # idSaveOptions.no
  }
  if ($script:app) { try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($script:app) | Out-Null } catch {} }
  $script:app = $null
}

try {
  switch ($ext) {

    '.psd' {
      # Photoshop: open then SaveAs PDF (as copy, leave source untouched)
      $names = @('Photoshop')
      $before = Get-ProcIds $names
      $app = New-Object -ComObject Photoshop.Application
      $launched = Report-NewProcs $names $before
      $prevDialogs = $null
      try { $prevDialogs = $app.DisplayDialogs; $app.DisplayDialogs = 3 } catch {}   # psDisplayNoDialogs
      $doc = Find-OpenDoc $app $full
      $wasOpen = [bool]$doc
      if (-not $doc) { $doc = $app.Open($full) }
      try {
        $opts = New-Object -ComObject Photoshop.PDFSaveOptions
        $doc.SaveAs($OutPath, $opts, $true)            # asCopy = true
      } finally {
        if (-not $wasOpen) { try { $doc.Close(2) } catch {} }   # psDoNotSaveChanges
        if ($null -ne $prevDialogs) { try { $app.DisplayDialogs = $prevDialogs } catch {} }
      }
      break
    }

    '.indd' {
      # InDesign: open then Export to PDF using the first export preset
      $isIndd = $true
      $names = @('InDesign')
      $before = Get-ProcIds $names
      $app = New-Object -ComObject InDesign.Application
      $launched = Report-NewProcs $names $before
      $prevLevel = $null
      try { $prevLevel = $app.ScriptPreferences.UserInteractionLevel; $app.ScriptPreferences.UserInteractionLevel = 1699311169 } catch {}  # idNeverInteract
      $doc = Find-OpenDoc $app $full
      $wasOpen = [bool]$doc
      if (-not $doc) { $doc = $app.Open($full) }
      try {
        $preset = $null
        try { $preset = $app.PDFExportPresets.Item("[High Quality Print]") } catch {}
        if (-not $preset) { $preset = $app.PDFExportPresets.Item(1) }   # locale-independent fallback
        # 1952403524 = idExportFormat.pdfType ("Adobe PDF (Print)")
        $doc.Export(1952403524, $OutPath, $false, $preset)
      } finally {
        if (-not $wasOpen) { try { $doc.Close(1852776480) } catch {} }   # idSaveOptions.no
        if ($null -ne $prevLevel) { try { $app.ScriptPreferences.UserInteractionLevel = $prevLevel } catch {} }
      }
      break
    }

    '.ai' {
      # Fallback only: non-PDF-compatible .ai. Illustrator COM may be unavailable
      # (newer versions dropped the COM server) -> give an actionable error.
      $names = @('Illustrator')
      $before = Get-ProcIds $names
      $progids = @('Illustrator.Application.29','Illustrator.Application.28','Illustrator.Application')
      foreach ($p in $progids) { try { $app = New-Object -ComObject $p; break } catch {} }
      if (-not $app) {
        Write-Error "Illustrator COM not available. Re-save the .ai with 'Create PDF Compatible File' enabled."
        exit 1
      }
      $launched = Report-NewProcs $names $before
      $prevLevel = $null
      try { $prevLevel = $app.UserInteractionLevel; $app.UserInteractionLevel = -1 } catch {}  # aiDontDisplayAlerts
      $doc = Find-OpenDoc $app $full
      $wasOpen = [bool]$doc
      if (-not $doc) { $doc = $app.Open($full) }
      try {
        $opts = New-Object -ComObject Illustrator.PDFSaveOptions
        $doc.SaveAs($OutPath, $opts)
      } finally {
        if (-not $wasOpen) { try { $doc.Close(2) } catch {} }   # aiDoNotSaveChanges
        if ($null -ne $prevLevel) { try { $app.UserInteractionLevel = $prevLevel } catch {} }
      }
      break
    }

    default { Write-Error "unsupported adobe format: $ext"; exit 1 }
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
