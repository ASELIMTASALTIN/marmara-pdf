# Code signing the Windows installer

Unsigned installers trigger Microsoft Defender SmartScreen ("Windows protected
your PC"). Signing is wired into the build: Tauri calls
`scripts/sign-windows.ps1` for the app executable and both installers
(`bundle.windows.signCommand` in `src-tauri/tauri.conf.json`). Without
configuration the script leaves the files unsigned, so local builds work.

SmartScreen only trusts signatures that chain to a public certification
authority (and builds reputation over time). A self-signed certificate
proves integrity but does **not** remove the warning for the public.

## Option 1 — Azure Trusted Signing (recommended, low cost)

Microsoft's managed signing service (identity validated by Microsoft,
certificates are short-lived and kept in the cloud). Signatures are trusted by
SmartScreen.

1. Create a Trusted Signing account and certificate profile in Azure.
2. Install the Trusted Signing client (`Microsoft.Trusted.Signing.Client`,
   provides `Azure.CodeSigning.Dlib.dll`).
3. Create `metadata.json`:
   ```json
   { "Endpoint": "https://<region>.codesigning.azure.net", "CodeSigningAccountName": "<account>", "CertificateProfileName": "<profile>" }
   ```
4. Sign in (`az login`) or set service-principal variables, then build:
   ```powershell
   $env:MARMARA_SIGN_AZURE_DLIB = "C:\tools\Azure.CodeSigning.Dlib.dll"
   $env:MARMARA_SIGN_AZURE_METADATA = "C:\tools\metadata.json"
   npm run tauri build
   ```

## Option 2 — Certificate from a certification authority

An OV or EV code-signing certificate (e.g. Certum, Sectigo, DigiCert;
Certum offers an inexpensive certificate for open-source developers). Since
2023 private keys must live on a hardware token or cloud HSM.

* Token / certificate store (also EV):
  ```powershell
  $env:MARMARA_SIGN_THUMBPRINT = "<certificate SHA-1 thumbprint>"
  npm run tauri build
  ```
* `.pfx` file (where the CA still allows it):
  ```powershell
  $env:MARMARA_SIGN_PFX = "C:\certs\marmara.pfx"
  $env:MARMARA_SIGN_PASSWORD = "<password>"
  npm run tauri build
  ```

## Option 3 — Self-signed (testing / internal use)

```powershell
powershell -File scripts/create-test-cert.ps1 -Out C:\certs\marmara-test -Password "<password>"
$env:MARMARA_SIGN_PFX = "C:\certs\marmara-test.pfx"; $env:MARMARA_SIGN_PASSWORD = "<password>"
npm run tauri build
```

Machines that should trust it need `marmara-test.cer` in *Trusted Root
Certification Authorities* and *Trusted Publishers* (e.g. via Group Policy).

## Timestamping

Signatures are timestamped (default `http://timestamp.digicert.com`, override
with `MARMARA_TIMESTAMP_URL`, `none` to skip) so they stay valid after the
certificate expires.

## Verifying

```powershell
Get-AuthenticodeSignature "src-tauri\target\release\bundle\nsis\Marmara PDF_0.1.0_x64-setup.exe"
```
`Valid` = trusted chain; `UnknownError` = signed with an untrusted (e.g.
self-signed) certificate.
