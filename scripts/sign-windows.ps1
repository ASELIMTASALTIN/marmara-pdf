# Code-signs a Windows binary (called by Tauri for the app exe and the installers).
#
# Configure ONE of the following (environment variables):
#   MARMARA_SIGN_PFX + MARMARA_SIGN_PASSWORD   - certificate file (.pfx/.p12)
#   MARMARA_SIGN_THUMBPRINT                    - certificate in the Windows store
#                                                (also hardware tokens / EV certificates)
#   MARMARA_SIGN_AZURE_DLIB + MARMARA_SIGN_AZURE_METADATA
#                                              - Azure Trusted Signing (signtool dlib + metadata.json)
# Optional:
#   MARMARA_TIMESTAMP_URL  - RFC 3161 timestamp server (default DigiCert; "none" to skip)
#   SIGNTOOL               - explicit path to signtool.exe
#
# Without configuration the script prints a notice and exits successfully, so
# local builds keep working unsigned.
param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = "Stop"

function Find-SignTool {
    if ($env:SIGNTOOL -and (Test-Path $env:SIGNTOOL)) { return $env:SIGNTOOL }
    $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    $found = Get-ChildItem -Path $kits -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\x64\\" } | Sort-Object FullName -Descending | Select-Object -First 1
    if ($found) { return $found.FullName }
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

$mode = $null
if ($env:MARMARA_SIGN_PFX) { $mode = "pfx" }
elseif ($env:MARMARA_SIGN_THUMBPRINT) { $mode = "store" }
elseif ($env:MARMARA_SIGN_AZURE_DLIB -and $env:MARMARA_SIGN_AZURE_METADATA) { $mode = "azure" }

if (-not $mode) {
    Write-Host "[sign] Code signing not configured - '$File' left unsigned. See docs/CODE_SIGNING.md."
    exit 0
}

$signtool = Find-SignTool
if (-not $signtool) { throw "[sign] signtool.exe not found. Install the Windows SDK or set SIGNTOOL." }

$args = @("sign", "/fd", "sha256", "/d", "Marmara PDF")
$ts = if ($env:MARMARA_TIMESTAMP_URL) { $env:MARMARA_TIMESTAMP_URL } else { "http://timestamp.digicert.com" }
if ($ts -ne "none") { $args += @("/tr", $ts, "/td", "sha256") }

switch ($mode) {
    "pfx" {
        if (-not (Test-Path $env:MARMARA_SIGN_PFX)) { throw "[sign] Certificate file not found: $env:MARMARA_SIGN_PFX" }
        $args += @("/f", $env:MARMARA_SIGN_PFX)
        if ($env:MARMARA_SIGN_PASSWORD) { $args += @("/p", $env:MARMARA_SIGN_PASSWORD) }
    }
    "store" { $args += @("/sha1", $env:MARMARA_SIGN_THUMBPRINT) }
    "azure" { $args += @("/dlib", $env:MARMARA_SIGN_AZURE_DLIB, "/dmdf", $env:MARMARA_SIGN_AZURE_METADATA) }
}
$args += $File

# Timestamp servers are occasionally unavailable: retry a few times.
for ($attempt = 1; $attempt -le 3; $attempt++) {
    & $signtool @args
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[sign] Signed $File ($mode)"
        exit 0
    }
    Write-Warning "[sign] signtool failed (attempt $attempt), retrying..."
    Start-Sleep -Seconds (3 * $attempt)
}
throw "[sign] Signing failed for $File"
