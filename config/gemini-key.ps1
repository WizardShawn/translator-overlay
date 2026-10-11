# Translator Overlay - Gemini API key storage.
# The key is encrypted with Windows DPAPI (CurrentUser scope): only this Windows
# account on this PC can decrypt it. The file is safe to keep in a synced folder.
#
# Use from other scripts:
#   . "$PSScriptRoot\gemini-key.ps1"
#   $key = Get-GeminiKey
#
# File format (gemini-key.dpapi.json):
#   format      "dpapi-currentuser-v1"
#   entropy     extra secret mixed into DPAPI, UTF-8 string below
#   blob        base64 of ProtectedData.Protect(UTF8(key), UTF8(entropy), CurrentUser)
#   hint        last 4 characters of the key, to tell keys apart
#   saved_at    ISO time
# Any language can read it: .NET ProtectedData.Unprotect, or CryptUnprotectData via ctypes in Python.

Add-Type -AssemblyName System.Security

$script:GeminiKeyFile = Join-Path $PSScriptRoot 'gemini-key.dpapi.json'
$script:GeminiKeyEntropy = 'TranslatorOverlay/gemini/v1'

function Protect-GeminiKey {
    param([Parameter(Mandatory)][string]$Key, [string]$Path = $script:GeminiKeyFile)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Key)
    $ent = [Text.Encoding]::UTF8.GetBytes($script:GeminiKeyEntropy)
    $blob = [Security.Cryptography.ProtectedData]::Protect($bytes, $ent, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Array]::Clear($bytes, 0, $bytes.Length)
    $record = [ordered]@{
        format   = 'dpapi-currentuser-v1'
        entropy  = $script:GeminiKeyEntropy
        hint     = $Key.Substring([Math]::Max(0, $Key.Length - 4))
        saved_at = (Get-Date).ToString('s')
        blob     = [Convert]::ToBase64String($blob)
    }
    $json = $record | ConvertTo-Json
    [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
}

function Get-GeminiKeyInfo {
    param([string]$Path = $script:GeminiKeyFile)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return [IO.File]::ReadAllText($Path) | ConvertFrom-Json
}

function Get-GeminiKey {
    param([string]$Path = $script:GeminiKeyFile)
    $info = Get-GeminiKeyInfo -Path $Path
    if ($null -eq $info) { throw "No Gemini key saved yet. Run 'Set Gemini Key.cmd' in $PSScriptRoot." }
    if ($info.format -ne 'dpapi-currentuser-v1') { throw "Unknown key file format: $($info.format)" }
    $ent = [Text.Encoding]::UTF8.GetBytes($info.entropy)
    try {
        $plain = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($info.blob), $ent, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    } catch {
        throw "This key was saved by a different Windows account or PC. Run 'Set Gemini Key.cmd' again here."
    }
    $key = [Text.Encoding]::UTF8.GetString($plain)
    [Array]::Clear($plain, 0, $plain.Length)
    return $key
}

function Test-GeminiKey {
    # Returns @{ ok; kind = 'ok'|'rejected'|'network'; message; models }
    param([Parameter(Mandatory)][string]$Key)
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $models = @()
    $token = $null
    try {
        do {
            $uri = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'
            if ($token) { $uri += "&pageToken=$token" }
            $r = Invoke-RestMethod -Uri $uri -Headers @{ 'x-goog-api-key' = $Key } -TimeoutSec 15
            foreach ($m in $r.models) {
                if ($m.supportedGenerationMethods -contains 'generateContent') { $models += ($m.name -replace '^models/', '') }
            }
            $token = $r.nextPageToken
        } while ($token)
        return @{ ok = $true; kind = 'ok'; message = "Key works. $($models.Count) models available."; models = $models }
    } catch {
        $resp = $_.Exception.Response
        if ($resp -and [int]$resp.StatusCode -in 400, 401, 403) {
            $code = [int]$resp.StatusCode
            $msg = if ($code -eq 403) { 'Google refused this key (403). The Generative Language API may be off for its project.' } else { "Google rejected this key ($code). Check that you copied all of it." }
            return @{ ok = $false; kind = 'rejected'; message = $msg; models = @() }
        }
        return @{ ok = $false; kind = 'network'; message = "Could not reach Google to check the key: $($_.Exception.Message)"; models = @() }
    }
}
