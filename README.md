# Marmara PDF

A free, open-source PDF reader and editor for Windows, with a built-in local AI
**Assistant**. Everything runs on your computer: documents are never uploaded.

**Download:** [latest release](https://github.com/ASELIMTASALTIN/marmara-pdf/releases/latest)
(installer, or portable zip). Updates install from the app: ⚙ ▸ *Check for updates*.

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
digital signatures with verification, password-protected PDFs, crash recovery.
The **Assistant** side panel (Ctrl+J) edits the open PDF from written requests
using a local model — see [docs/AI.md](docs/AI.md). Light and dark themes.
Everything is also scriptable through the `marmara` command line and usable by
local LLMs as an MCP server — see [docs/LLM.md](docs/LLM.md) and
[docs/CLI.md](docs/CLI.md). See [FEATURES.md](FEATURES.md) and
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
npm run build:cli      # command line into dist-cli/ (then: npm run cli -- help)
npm run build:engine   # local AI engine (llama.cpp) into ai-engine/ — see docs/AI.md
```

## Test

```sh
npm test                           # unit tests (vitest)
npm run test:cli                   # builds the command line and runs every command + the MCP server
cd src-tauri && cargo test         # Rust tests (atomic writes, path decoding)
node scripts/make-fixtures.mjs     # generate test PDFs into test-fixtures/
```

UI tests (`tests/ui/*.js`) are Playwright snippets run against `npm run dev`.
End-to-end tests against the built app (`tests/e2e/*.mjs`) connect over
WebView2 remote debugging: start the app with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`.

## Build and release

```sh
npm run build:engine              # once (or after updating llama.cpp)
node scripts/release.mjs          # build + release/v<version>/ (Setup folder with model, Portable folder)
node scripts/release.mjs --publish  # … and publish a GitHub release (installer, MSI, portable zip, latest.json)
```

Put the model file in `models/` (git-ignored) to include it in the local packages.
Updates are signed with a minisign key kept outside the repository
(`%USERPROFILE%\.tauri\marmara-pdf.key`); its public half is in
`src-tauri/tauri.conf.json`. Without the key, builds work but cannot be published as updates.
The installer registers Marmara PDF as an editor for `.pdf` files and puts the
`marmara` command line on the user's PATH. To sign the executables (removes the
SmartScreen warning), see [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md).
