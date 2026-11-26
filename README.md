# Marmara PDF

A free, open-source PDF reader and editor for Windows. Everything runs locally:
documents are never uploaded and nothing is downloaded at runtime.

**Features:** fast virtualized viewer, search (Turkish-aware), page management
(insert, delete, duplicate, rotate, reorder, extract, merge, split), real text
editing in the PDF content stream, annotations (highlight, underline,
strikethrough, drawing, shapes, text boxes, notes, signatures, images), form
filling, OCR for scanned documents (Turkish + English), password-protected
PDFs, crash recovery. See [FEATURES.md](FEATURES.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Built with Tauri 2 (Rust + WebView2), React, TypeScript, pdf.js, pdf-lib,
MuPDF.js and Tesseract.js. Licensed under **AGPL-3.0-or-later**.

## Requirements

* Windows 10/11 (WebView2 is preinstalled on Windows 11)
* Node.js 20+, Rust (MSVC toolchain), Visual Studio C++ build tools

## Develop

```sh
npm install
npm run tauri dev      # desktop app with hot reload
npm run dev            # UI only, in a normal browser (http://localhost:1420)
```

## Test

```sh
npm test                           # unit tests (page ops, search, annotations, text editing, forms)
cd src-tauri && cargo test         # Rust tests (atomic writes, path decoding)
node scripts/make-fixtures.mjs     # generate test PDFs into test-fixtures/
```

UI tests (`tests/ui/*.js`) are Playwright snippets run against `npm run dev`.
End-to-end tests against the built app (`tests/e2e/*.mjs`) connect over
WebView2 remote debugging: start the app with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`.

## Build the Windows installer

```sh
npm run tauri build
```

Output: `src-tauri/target/release/bundle/nsis/Marmara PDF_<version>_x64-setup.exe`
and `src-tauri/target/release/bundle/msi/…msi`. The installer registers
Marmara PDF as an editor for `.pdf` files.
