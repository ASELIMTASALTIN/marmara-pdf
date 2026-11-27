# Marmara PDF — Architecture

Marmara PDF is a Windows desktop PDF reader/editor built with **Tauri 2** (Rust
backend, WebView2 frontend), **React + TypeScript**, **pdf.js** (rendering),
**pdf-lib** (page operations), **MuPDF.js** (annotations, text editing, forms,
encryption) and **Tesseract.js** (OCR). All processing is local; nothing is
uploaded and no assets are fetched from the internet at runtime.

License: **AGPL-3.0-or-later** (required by MuPDF).

## Layers

```
src-tauri/            Rust: atomic file I/O, crash-recovery store, "Open with…"
src/
  platform/           Host abstraction (Tauri implementation + browser fallback)
  core/               Pure document logic, no React
    pdf/              pdf.js loading, page sizes, pdf-lib page operations
    search/           Text extraction model + Turkish-aware search
    annotations/      Annotation model, geometry, MuPDF bake/import
    textedit/         Content-stream parser, font decoding, text interpreter, editor
    ocr/              Tesseract wrapper + invisible text-layer writer
    forms/            AcroForm value writer, field creation/removal
    convert/          PDF → docx/text, images → PDF
    signature/        Digital IDs, CMS build/verify, PAdES signing
    redact/           Redaction (MuPDF Redact annotations + apply)
    optimize/         Compression, preflight checks/fixes, PDF/A conversion
    stamp/            Headers/footers, page & Bates numbers, watermarks
    outline/          Bookmark tree read/write and editing helpers
    objects/          Page image / vector-graphic hit testing and editing
    compare/          Word extraction + Myers diff between two documents
    mupdf/            Lazy MuPDF loader, encryption helpers
  state/              zustand stores: document (bytes, undo/redo), UI, search, dialogs;
                      sessions.ts parks inactive tabs' document state
  actions/            Orchestration: file, page, annotation, text-edit, OCR, print,
                      redaction, stamps, compare, batch, comments (XFDF), commands
  components/         React UI (viewer, sidebar, toolbars, dialogs, overlays)
  hooks/              Shortcuts, lifecycle (drop, autosave, close guard), text markup
  cli/                Command line + MCP server over the same core (Node.js)
```

## Document model

* The **PDF bytes are the source of truth.** pdf.js renders a proxy loaded from
  them. Structural edits (page operations, text edits, OCR) produce *new bytes*
  and reload the proxy.
* **Undo/redo** stores snapshots `{bytes, pageIds, annotations, formValues}`.
  Unchanged parts share references, so annotation/form edits cost nothing.
* Pages have **stable ids** so annotations follow pages through reorder,
  duplicate and delete.
* **Annotations** stay editable objects (PDF user-space geometry) until save,
  when MuPDF writes them as real PDF annotations with appearance streams. Each
  carries its model under `/MarmaraData`, so reopening restores them as
  editable objects.
* **Form values** are kept per field name and written by MuPDF on save.
* **Encrypted files** are decrypted to an in-memory working copy after the
  password prompt; saving re-applies the password (AES-256).

## Text editing

`core/textedit` implements genuine content-stream editing:

1. Parse the page content stream into operators (inline images preserved).
2. Decode every font (ToUnicode, standard encodings, `/Differences`, CID
   Identity-H, widths) and interpret the stream to find each text-showing
   operator with its decoded text, position, size, colour and text state.
3. Group operators into editable line blocks.
4. **In-place edit** (preferred): rewrite the original `Tj/TJ` operators in the
   original font when every glyph is available (subset fonts: glyphs known to be
   embedded). Size/colour changes insert scoped `Tf`/colour operators.
5. **Re-typeset** (fallback, reported to the user): when the font lacks a
   glyph, another family is chosen, or the text is moved, the original
   operators are removed and the new text is typeset *as page content* at the
   same transform — with the original font when possible, otherwise a built-in
   Unicode font (Helvetica/Times/Courier families, full Turkish support).

No annotation-based "fake" editing is used.

## OCR

Pages without real text are detected, rendered at ~300 DPI and recognised with
Tesseract (Turkish + English models bundled). Words are written back as an
invisible (`Tr 3`) text layer aligned with the image, wrapped in
`/MarmaraOCR BMC … EMC` so a re-run replaces it. The text becomes searchable,
selectable, copyable and editable with the normal tools.

## Page stamps and object editing

Headers/footers, Bates numbers and watermarks are appended to the page content
inside marked-content groups (`/MarmaraHF`, `/MarmaraBates`, `/MarmaraWM`), so
each kind can be re-applied or removed without touching the others or the
original content. Object editing wraps the chosen image or path operators in
`q <matrix> cm … Q` (the matrix is conjugated by the current CTM so moves and
resizes are in displayed space), rewrites their colour operators, swaps the
image XObject, or removes them.

## Tabs

Only the active document lives in the `useDoc` store. Switching tabs parks
its full state (bytes, undo stacks, annotations, form values, view position)
in `state/sessions.ts` and restores the other one, so every tab keeps its own
history. Closing or quitting checks every tab for unsaved changes.

## Command line and MCP server

`src/cli` runs the same `core/` modules under Node.js; only pdf.js (rendering)
is not used, MuPDF renders instead (OCR input, `to-images`). Each command is
declared once in a registry (`defineCommand`: parameters with types,
descriptions, defaults). The argument parser, `marmara help`, the generated
reference ([CLI.md](CLI.md)), the JSON Schemas of `marmara commands` and the
MCP tools (`marmara mcp`, newline-delimited JSON-RPC over stdio) are all
derived from these declarations, so they cannot drift apart.

Conventions shared by every command: results are JSON; inputs are never
modified unless `--overwrite` is given; display coordinates (points from the
top-left of the shown page) are converted to PDF user space at the boundary
(`cli/io.ts`); encrypted inputs are re-encrypted with the same password;
rewriting a signed file needs `--break-signatures`; `--root` confines file
access for MCP clients.

Packaging: `scripts/build-cli.mjs` bundles the CLI with Vite into
`dist-cli/marmara.mjs` and copies MuPDF, Tesseract (LSTM cores only) and the
OCR models next to it. The installer ships that folder as `cli\` with a
private `node.exe`; `marmara.exe` (`src-tauri/src/bin/marmara.rs`) is a tiny
console launcher, and the NSIS hook / WiX fragment add the install folder to
PATH.

## Performance

* Virtualized viewer: only pages near the viewport exist in the DOM; canvases
  are capped at 16 MP; zoom re-renders are debounced while the old bitmap is
  CSS-scaled.
* Text layers scale via CSS variables (no rebuild on zoom).
* Thumbnails are virtualized and cached per document revision.
* MuPDF (WASM, ~10 MB) and Tesseract load lazily on first use.

## Reliability

* Atomic saves (temp file + rename); the original is only overwritten after an
  explicit confirmation ("Save a copy" offered).
* Crash-recovery snapshots every 30 s while there are unsaved changes; offered
  on the start screen after a crash.
* Corrupt/unsupported/password-protected files are handled with clear dialogs.
* All document mutations run through a serial queue (no races).
