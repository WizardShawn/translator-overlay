# Opens the test game in its own Chrome app window. Usage: launch-game.ps1 [-Every 7000] [-Start 0]
param([int]$Every = 7000, [int]$Start = 0)
$page = Join-Path $PSScriptRoot 'game\index.html'
$url = ([Uri]$page).AbsoluteUri + "?every=$Every&start=$Start"
$profile = Join-Path $env:TEMP 'translator-overlay-testgame'
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Google Chrome not found' }
Start-Process $chrome -ArgumentList @("--app=$url", "--user-data-dir=$profile", '--window-size=1280,760', '--window-position=60,40', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,TranslateUI', '--lang=en-US')
