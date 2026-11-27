# Marmara PDF

A free, open-source PDF reader and editor for Windows. Everything runs locally:
documents are never uploaded and nothing is downloaded at runtime.

**Features:** fast virtualized viewer with tabs for several documents, search
(Turkish-aware), printing, page management (insert, delete, duplicate, rotate,
reorder, extract, merge, split), real text and paragraph editing in the PDF
content stream, editing of page images and vector graphics, annotations
(highlight, underline, strikethrough, drawing, shapes, text boxes, notes,
signatures, images) with XFDF comment exchange, form filling and form
creation, redaction (search and area, true content removal), OCR for scanned
documents (Turkish + English), headers/footers, page and Bates numbering,
watermarks, bookmarks, document comparison, file-size reduction, document
check (accessibility/archiving) and PDF/A conversion, batch processing,
conversion (PDF → Word / images / text, images → PDF), certificate-based
digital signatures with verification, password-protected PDFs, crash recovery. See [FEATURES.md](FEATURES.md) and
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
npm test                           # unit tests (vitest)
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
Marmara PDF as an editor for `.pdf` files. To sign the installer (removes the
SmartScreen warning with a trusted certificate), see
[docs/CODE_SIGNING.md](docs/CODE_SIGNING.md).
