@echo off
REM ===========================================================
REM  PDF analyzer - update an old version (3.8 or older) in place.
REM  Double-click me. Runs update-from-old.ps1 next to this file.
REM ===========================================================
chcp 65001 >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-from-old.ps1" %*
