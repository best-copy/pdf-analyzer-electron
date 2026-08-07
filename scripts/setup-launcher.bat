@echo off
REM ===========================================================
REM  PDF analyzer - portable setup launcher (double-click me)
REM  Runs install-portable.ps1 with elevation prompt.
REM ===========================================================
chcp 65001 >nul 2>&1
set "PS1=%~dp0install-portable.ps1"
if not exist "%PS1%" set "PS1=%~dp0scripts\install-portable.ps1"
if not exist "%PS1%" (
  echo install-portable.ps1 not found next to this file.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
