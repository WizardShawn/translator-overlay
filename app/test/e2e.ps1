# End-to-end run against the test game.
# Starts the test game and the app, takes screenshots of the game window at the given seconds, then closes both.
param([int[]]$ShotsAt = @(15, 30), [int]$Every = 7000, [int]$Start = 0, [string]$Out = "$env:TEMP\to-e2e", [switch]$KeepOpen, [string[]]$ExtraArgs = @())
$ErrorActionPreference = 'Stop'
$app = Split-Path $PSScriptRoot -Parent
New-Item -ItemType Directory -Force $Out | Out-Null
Get-ChildItem $Out -Filter *.png -ErrorAction SilentlyContinue | Remove-Item

Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -Namespace E2E -Name W -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
public struct RECT { public int L, T, R, B; }
'@
[void][E2E.W]::SetProcessDPIAware()

Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*translator-overlay-testgame*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500
& (Join-Path $PSScriptRoot 'launch-game.ps1') -Every $Every -Start $Start
$title = [string]::new([char[]]@(0x706F, 0x5B88, 0x306E, 0x753A))   # the test game's title
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 160 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 250; $h = [E2E.W]::FindWindow([NullString]::Value, $title) }
if ($h -eq [IntPtr]::Zero) { throw 'Test game window not found' }
Start-Sleep -Seconds 2

$electron = Join-Path $app 'node_modules\electron\dist\electron.exe'
$p = Start-Process $electron -ArgumentList (@('.', "--start=$title", '--debug-visible', '--debug-always-show', '--debug-dump', '--hidden') + $ExtraArgs) -WorkingDirectory $app -PassThru
$t0 = Get-Date
foreach ($s in $ShotsAt) {
  $wait = $s - ((Get-Date) - $t0).TotalSeconds
  if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]($wait * 1000)) }
  $r = New-Object E2E.W+RECT
  [void][E2E.W]::GetWindowRect($h, [ref]$r)
  $bmp = New-Object Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
  $file = Join-Path $Out ("shot-{0:D3}s.png" -f $s)
  $bmp.Save($file, [Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "saved $file"
}
if (-not $KeepOpen) {
  Stop-Process -Id $p.Id -ErrorAction SilentlyContinue
  Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $electron } | Stop-Process -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*translator-overlay-testgame*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
}
