# PDF Editor print helper entry (ASCII only).
# All inputs come from environment variables (no command-line quoting / injection):
#   PE_MODE     info | props | print
#   PE_CS       path of print_helper.cs      PE_DLL  cached compiled assembly path
#   PE_PRINTER  queue name                   PE_DEVMODE  base64 DEVMODE from a previous call (optional)
#   PE_COPIES PE_COLLATE PE_DUPLEX PE_ORIENT PE_COLOR PE_PAPER   overrides written into the DEVMODE (optional)
#   props: PE_HWND (owner window handle, decimal)
#   print: PE_PDFIUM PE_FILE PE_DOCNAME PE_PAGES(0-based, comma) PE_SCALE PE_PCT PE_AUTOROT PE_GRAY PE_ANNOT PE_PAPERBYPAGE
#          PE_OUTPUT (tests only: StartDoc output file instead of the printer port)
# Output: info/props -> "JSON:<json>", print -> "P:i/n" lines then "OK:<pages>"; failure -> "ERR:<message>" (exit 1)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
  if (-not ('PePrint' -as [type])) {
    if ($env:PE_DLL -and (Test-Path -LiteralPath $env:PE_DLL)) {
      Add-Type -LiteralPath $env:PE_DLL
    } else {
      $src = [IO.File]::ReadAllText($env:PE_CS)
      if ($env:PE_DLL) {
        $dir = Split-Path -Parent $env:PE_DLL
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $tmp = $env:PE_DLL + '.' + $PID + '.tmp'
        Add-Type -TypeDefinition $src -OutputAssembly $tmp -OutputType Library
        try { Move-Item -LiteralPath $tmp -Destination $env:PE_DLL -Force } catch { }
        if (Test-Path -LiteralPath $env:PE_DLL) { Add-Type -LiteralPath $env:PE_DLL } else { Add-Type -LiteralPath $tmp }
      } else {
        Add-Type -TypeDefinition $src
      }
    }
  }
  function IntEnv($name, $def) { $v = [Environment]::GetEnvironmentVariable($name); if ($v -match '^-?\d+$') { [int]$v } else { $def } }
  [PeOverrides]::Copies = IntEnv 'PE_COPIES' 0
  [PeOverrides]::Collate = IntEnv 'PE_COLLATE' -1
  [PeOverrides]::Duplex = IntEnv 'PE_DUPLEX' 0
  [PeOverrides]::Orient = IntEnv 'PE_ORIENT' 0
  [PeOverrides]::Color = IntEnv 'PE_COLOR' 0
  [PeOverrides]::PaperSize = IntEnv 'PE_PAPER' 0

  switch ($env:PE_MODE) {
    'info'  { Write-Output ('JSON:' + [PePrint]::Info($env:PE_PRINTER, $env:PE_DEVMODE)) }
    'props' { Write-Output ('JSON:' + [PePrint]::Props($env:PE_PRINTER, $env:PE_DEVMODE, [long](IntEnv 'PE_HWND' 0))) }
    'print' {
      $pages = [int[]]@($env:PE_PAGES -split ',' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
      $pct = 100.0
      [void][double]::TryParse([string]$env:PE_PCT, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$pct)
      $n = [PePrint]::Print($env:PE_PRINTER, $env:PE_DEVMODE, $env:PE_PDFIUM, $env:PE_FILE, $env:PE_DOCNAME, $pages,
        $env:PE_SCALE, $pct, ($env:PE_AUTOROT -eq '1'), ($env:PE_GRAY -eq '1'), ($env:PE_ANNOT -ne '0'), ($env:PE_PAPERBYPAGE -eq '1'), $env:PE_OUTPUT)
      Write-Output "OK:$n"
    }
    default { throw "unknown mode" }
  }
} catch {
  Write-Output ('ERR:' + ($_.Exception.Message -replace '[\r\n]+', ' '))
  exit 1
}
