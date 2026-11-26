# Creates a self-signed code-signing certificate for TESTING the signing
# pipeline or for internal distribution (machines that trust it via
# "Trusted Publishers"/"Trusted Root", e.g. pushed by Group Policy).
# It does NOT remove the SmartScreen warning for the public: that needs a
# certificate from a trusted CA or Azure Trusted Signing (see docs/CODE_SIGNING.md).
#
# Usage: powershell -File scripts/create-test-cert.ps1 -Out C:\certs\marmara-test -Password "s3cret"
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [Parameter(Mandatory = $true)][string]$Password,
    [string]$Subject = "CN=Marmara PDF (test signing)"
)
$ErrorActionPreference = "Stop"
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Subject -CertStoreLocation Cert:\CurrentUser\My `
    -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(3)
try {
    $secure = ConvertTo-SecureString -String $Password -Force -AsPlainText
    Export-PfxCertificate -Cert $cert -FilePath "$Out.pfx" -Password $secure | Out-Null
    Export-Certificate -Cert $cert -FilePath "$Out.cer" | Out-Null
    Write-Host "Created $Out.pfx (private key) and $Out.cer (public certificate)"
    Write-Host "Thumbprint: $($cert.Thumbprint)"
} finally {
    # Keep the user's certificate store clean: the .pfx is the only copy of the key.
    Remove-Item -Path "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey
}
