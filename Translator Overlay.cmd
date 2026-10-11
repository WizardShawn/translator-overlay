@echo off
if not exist "%~dp0app\node_modules\electron\dist\electron.exe" (
  echo Translator Overlay is not installed yet. Open the app folder in a terminal and run: npm install
  pause
  exit /b 1
)
start "" "%~dp0app\node_modules\electron\dist\electron.exe" "%~dp0app"
