# Opens a small window to paste the Gemini API key, checks it with Google,
# and saves it encrypted next to this script. Launch via "Set Gemini Key.cmd".
# -SelfTest runs an encrypt/decrypt round trip with a dummy value and no window.
param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'gemini-key.ps1')
$modelsFile = Join-Path $PSScriptRoot 'available-models.txt'

if ($SelfTest) {
    $tmp = Join-Path $env:TEMP ("gk-selftest-" + [guid]::NewGuid() + '.json')
    $dummy = 'SELFTEST-not-a-real-key-1234'
    Protect-GeminiKey -Key $dummy -Path $tmp
    $raw = [IO.File]::ReadAllText($tmp)
    $back = Get-GeminiKey -Path $tmp
    Remove-Item -LiteralPath $tmp
    if ($raw.Contains($dummy)) { throw 'Self-test failed: plain text found in file.' }
    if ($back -ne $dummy) { throw 'Self-test failed: round trip mismatch.' }
    Write-Output 'Self-test passed: encrypted on disk, decrypts to the same value.'
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace Win32 -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][Win32.Dpi]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()

$bg    = [Drawing.Color]::FromArgb(20, 23, 29)
$panel = [Drawing.Color]::FromArgb(27, 31, 39)
$line  = [Drawing.Color]::FromArgb(45, 51, 64)
$fg    = [Drawing.Color]::FromArgb(232, 234, 239)
$muted = [Drawing.Color]::FromArgb(145, 152, 167)
$sub   = [Drawing.Color]::FromArgb(243, 199, 79)
$ink   = [Drawing.Color]::FromArgb(29, 23, 4)
$ok    = [Drawing.Color]::FromArgb(95, 203, 142)
$bad   = [Drawing.Color]::FromArgb(238, 111, 111)
$warn  = [Drawing.Color]::FromArgb(240, 162, 77)
$font  = New-Object Drawing.Font('Segoe UI', 10)

$form = New-Object Windows.Forms.Form
$form.Text = 'Translator Overlay - Gemini API key'
$form.AutoScaleMode = 'Dpi'
$form.ClientSize = New-Object Drawing.Size(520, 300)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false; $form.MinimizeBox = $false
$form.TopMost = $true
$form.BackColor = $bg; $form.ForeColor = $fg; $form.Font = $font

function New-Label($text, $x, $y, $w, $h, $color, $size = 10, $bold = $false) {
    $l = New-Object Windows.Forms.Label
    $l.Text = $text; $l.Location = New-Object Drawing.Point($x, $y); $l.Size = New-Object Drawing.Size($w, $h)
    $l.ForeColor = $color
    $style = if ($bold) { [Drawing.FontStyle]::Bold } else { [Drawing.FontStyle]::Regular }
    $l.Font = New-Object Drawing.Font('Segoe UI', $size, $style)
    $form.Controls.Add($l); return $l
}

[void](New-Label 'Paste your Gemini API key' 24 20 470 28 $fg 13 $true)
$existing = Get-GeminiKeyInfo
$intro = 'It is encrypted with your Windows account and saved in this folder. Only you, on this PC, can read it.'
if ($existing) { $intro += " A key ending in ...$($existing.hint) is already saved; saving replaces it." }
[void](New-Label $intro 24 52 470 44 $muted 9.5)

$link = New-Object Windows.Forms.LinkLabel
$link.Text = 'Get a key at aistudio.google.com/apikey'
$link.Location = New-Object Drawing.Point(24, 98); $link.Size = New-Object Drawing.Size(470, 22)
$link.LinkColor = $sub; $link.ActiveLinkColor = $sub; $link.Font = New-Object Drawing.Font('Segoe UI', 9.5)
$link.Add_LinkClicked({ Start-Process 'https://aistudio.google.com/apikey' })
$form.Controls.Add($link)

$box = New-Object Windows.Forms.TextBox
$box.Location = New-Object Drawing.Point(24, 130); $box.Size = New-Object Drawing.Size(472, 30)
$box.UseSystemPasswordChar = $true
$box.BackColor = $panel; $box.ForeColor = $fg; $box.BorderStyle = 'FixedSingle'
$box.Font = New-Object Drawing.Font('Consolas', 11)
$form.Controls.Add($box)

$show = New-Object Windows.Forms.CheckBox
$show.Text = 'Show key'; $show.Location = New-Object Drawing.Point(24, 166); $show.Size = New-Object Drawing.Size(120, 24)
$show.ForeColor = $muted; $show.Font = New-Object Drawing.Font('Segoe UI', 9.5)
$show.Add_CheckedChanged({ $box.UseSystemPasswordChar = -not $show.Checked })
$form.Controls.Add($show)

$status = New-Label '' 24 198 472 42 $muted 9.5

function New-Button($text, $x, $w, $primary) {
    $b = New-Object Windows.Forms.Button
    $b.Text = $text; $b.Location = New-Object Drawing.Point($x, 248); $b.Size = New-Object Drawing.Size($w, 34)
    $b.FlatStyle = 'Flat'; $b.FlatAppearance.BorderColor = if ($primary) { $sub } else { $line }
    $b.BackColor = if ($primary) { $sub } else { $panel }
    $b.ForeColor = if ($primary) { $ink } else { $fg }
    $b.Font = New-Object Drawing.Font('Segoe UI', 10, $(if ($primary) { [Drawing.FontStyle]::Bold } else { [Drawing.FontStyle]::Regular }))
    $b.Cursor = 'Hand'
    $form.Controls.Add($b); return $b
}
$save   = New-Button 'Check and save' 336 160 $true
$cancel = New-Button 'Cancel' 226 100 $false
$force  = New-Button 'Save without checking' 24 190 $false
$force.Visible = $false
$form.AcceptButton = $save
$form.CancelButton = $cancel
$cancel.Add_Click({ $form.Close() })

$script:saved = $false
function Save-Key([string]$key, $models) {
    Protect-GeminiKey -Key $key
    if ($models -and $models.Count) {
        $lines = @("# Models this key can call, checked $((Get-Date).ToString('s')). Not secret.") + ($models | Sort-Object)
        [IO.File]::WriteAllLines($modelsFile, $lines)
    }
    $box.Text = ''
    $script:saved = $true
    $save.Text = 'Done'; $cancel.Visible = $false; $force.Visible = $false
    $box.Enabled = $false; $show.Enabled = $false
}

$save.Add_Click({
    if ($script:saved) { $form.Close(); return }
    $key = ($box.Text -replace '\s', '')
    if ($key.Length -lt 20) {
        $status.ForeColor = $bad; $status.Text = 'That is too short to be an API key. Paste the whole key.'; return
    }
    $status.ForeColor = $muted; $status.Text = 'Checking the key with Google...'
    $form.UseWaitCursor = $true; $form.Refresh()
    $r = Test-GeminiKey -Key $key
    $form.UseWaitCursor = $false
    if ($r.ok) {
        Save-Key $key $r.models
        $status.ForeColor = $ok
        $status.Text = "Saved. $($r.message) Key ending in ...$($key.Substring($key.Length - 4))."
    } elseif ($r.kind -eq 'network') {
        $status.ForeColor = $warn; $status.Text = $r.message
        $force.Visible = $true
    } else {
        $status.ForeColor = $bad; $status.Text = $r.message
    }
})
$force.Add_Click({
    $key = ($box.Text -replace '\s', '')
    if ($key.Length -lt 20) { return }
    Save-Key $key $null
    $status.ForeColor = $ok
    $status.Text = "Saved without checking. Key ending in ...$($key.Substring($key.Length - 4))."
})

$form.Add_Shown({ $form.Activate(); $box.Focus() })
[void]$form.ShowDialog()
if ($script:saved) { Write-Output 'saved' } else { Write-Output 'cancelled' }
