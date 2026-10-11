@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0set-gemini-key.ps1" %*
