# Marmara PDF — Feature checklist

Legend: ✅ implemented and tested · 🟡 implemented, limited · ⬜ not yet

Tests: **U** = unit test (vitest, `npm test`), **UI** = automated UI test in a
real browser (`tests/ui/*.js`, run with Playwright against `npm run dev`),
**M** = manual check.

## 1. Architecture & app
| Feature | Status | Test |
|---|---|---|
| Tauri 2 + React + TypeScript, modular architecture | ✅ | build |
| Local-only processing, offline assets (pdf.js, MuPDF, Tesseract + tur/eng) | ✅ | UI |
| Windows installer (NSIS + MSI), `.pdf` file association | ✅ | build |
| "Open with…" / command-line file | ✅ | M |

## 2. Viewer
| Feature | Status | Test |
|---|---|---|
| Open local PDFs (dialog), recent files | ✅ | UI |
| Drag & drop files (open / insert / combine) | ✅ | M |
| Multi-page rendering, smooth scrolling | ✅ | UI |
| Zoom in/out, Ctrl+wheel anchored zoom, presets | ✅ | UI |
| Fit page / fit width | ✅ | UI |
| Page navigation (input, buttons, PgUp/PgDn, Home/End, Ctrl+G) | ✅ | UI |
| Full-screen reading mode (F11) | ✅ | M |
| Text search (Turkish-aware case/diacritics, whole word, highlights) | ✅ | U, UI |
| Keyboard shortcuts | ✅ | UI |
| Large PDFs: virtualized rendering (400 pages: 2 pages in DOM, ~40 MB heap) | ✅ | UI |
| Hand tool, text selection & copy | ✅ | M |
| Several documents open in tabs (own undo, view and state; close/quit guards) | ✅ | UI |
| Printing (all / current / range, 150–300 DPI, with annotations and form values) | ✅ | UI (print dialog stubbed) |

## 3. Page management
| Feature | Status | Test |
|---|---|---|
| Thumbnails sidebar (virtualized) | ✅ | UI |
| Insert blank page | ✅ | U, UI |
| Insert pages from another PDF | ✅ | U |
| Delete / duplicate / rotate pages | ✅ | U, UI |
| Reorder by drag & drop (multi-select, auto-scroll) | ✅ | U, UI |
| Extract selected pages to new PDF | ✅ | U |
| Merge multiple PDFs (ordering dialog) | ✅ | U |
| Split (every N, at pages, custom ranges) | ✅ | U |
| Undo / redo for all page operations | ✅ | UI |
| Headers & footers with tokens ({page} {pages} {date} {file}), page numbering | ✅ | U, UI |
| Bates numbering (prefix, digits, suffix) | ✅ | U |
| Text watermarks (opacity, rotation); kinds replace/remove independently | ✅ | U, UI |
| Bookmarks: add, rename, nest, reorder, delete | ✅ | U, UI |

## 4. Text editing (genuine content-stream editing)
| Feature | Status | Test |
|---|---|---|
| Select existing text (line blocks) | ✅ | U, UI |
| Edit existing text in place in the original font | ✅ | U, UI |
| Delete text | ✅ | U |
| Insert new text (multi-line, Unicode/Turkish) | ✅ | U, UI |
| Font size, colour | ✅ | U |
| Font family (Original / Sans / Serif / Mono) | ✅ | U |
| Move text | ✅ | U |
| Fallback re-typesetting when the font lacks glyphs (reported to user) | ✅ | U, UI |
| Embedded subset fonts, rotated pages, TJ kerning | ✅ | U |
| Paragraph editing with re-flow (wrap to column width, same leading, justification, first-line indent) | ✅ | U, UI |
| Text inside form XObjects (copy-on-write per page) | ✅ | U |
| Type3 fonts | ✅ | U |
| Edit page images and vector graphics: select, move, resize, recolour, replace image, delete | ✅ | U |

## 5. Annotations
| Feature | Status | Test |
|---|---|---|
| Highlight / underline / strikethrough (text selection, multi-page) | ✅ | UI |
| Freehand drawing | ✅ | UI |
| Text boxes (Unicode) | ✅ | U, UI |
| Sticky notes | ✅ | UI |
| Shapes: rectangle, ellipse, line, arrow | ✅ | U, UI |
| Signatures (draw / type / upload, saved signatures) | ✅ | UI |
| Images | ✅ | U |
| Eraser / delete, select / move / resize, styles | ✅ | UI |
| Comments panel | ✅ | UI |
| Saved as real PDF annotations; reopen as editable | ✅ | U, UI |
| Export / import comments as XFDF (Acrobat-compatible) for review | ✅ | U |

## 6. OCR
| Feature | Status | Test |
|---|---|---|
| Detect scanned pages | ✅ | UI |
| Run OCR (Turkish + English, offline), progress & cancel | ✅ | UI |
| Automatic language: English pages re-read with the English model (no "İnvoice") | ✅ | UI |
| Search recognised text | ✅ | UI |
| Select / copy recognised text (aligned invisible layer) | ✅ | UI |
| Edit recognised text (edit-text tool on OCR layer) | 🟡 edits the invisible layer | M |

## 7. Forms
| Feature | Status | Test |
|---|---|---|
| Fill text, multi-line, checkbox, radio, dropdown/list | ✅ | U, UI |
| Saved with regenerated appearances | ✅ | U, UI |
| Create fields: text, multi-line, checkbox, radio, dropdown, signature; delete fields | ✅ | U, UI |

## 8. Conversion
| Feature | Status | Test |
|---|---|---|
| PDF → Word (.docx): paragraphs, fonts, bold/italic, alignment, images, page sizes | ✅ | U (opened in Word), UI |
| PDF → images (PNG/JPEG, 72–300 DPI, page ranges) | ✅ | M |
| PDF → plain text (UTF-8) | ✅ | U |
| Images → PDF (A4-fitted or image-sized pages) | ✅ | U |

## 9. Redaction, optimisation & checks
| Feature | Status | Test |
|---|---|---|
| Redaction: mark areas or search results, apply removes text, images and graphics underneath; optional metadata removal | ✅ | U, UI |
| Reduce file size (presets: screen / ebook / print / lossless; image downsampling, dedup) | ✅ | U, UI |
| Document check (preflight): accessibility, archiving and general problems, automatic fixes | ✅ | U, UI |
| Convert to PDF/A-2b (sRGB output intent, XMP metadata, embedded fonts) | 🟡 not validated with veraPDF | U |
| Compare two documents (word-level diff, result list, marked-up comparison tab) | ✅ | U, UI |
| Batch processing: compress, OCR, page numbers, watermark, Word, text, PDF/A on many files | ✅ | UI |
| Automatic accessibility tagging (structure tree) | ⬜ checks and fixes only | — |

## 10. Digital signatures
| Feature | Status | Test |
|---|---|---|
| Create self-signed digital ID / import .pfx / export / remove | ✅ | U, UI |
| Sign (PAdES, ETSI.CAdES.detached, SHA-256), visible or invisible, optional handwritten image | ✅ | U (OpenSSL-verified), UI |
| Multiple signatures (incremental updates keep earlier ones valid) | ✅ | U |
| Verify signatures: integrity, cryptographic validity, coverage, certificate; panel + banner | ✅ | U, UI |
| Annotations / forms on signed files saved incrementally (signatures stay valid) | ✅ | U |
| Certificate trust chain against a root store | ⬜ (reported as "identity not verified") | — |

## 11. File management
| Feature | Status | Test |
|---|---|---|
| Save / Save as | ✅ | UI |
| Original preserved unless overwrite is confirmed | ✅ | M |
| Atomic writes | ✅ | U (Rust) |
| Crash-recovery autosave | ✅ | M |
| Password-protected PDFs (open, edit, save keeps password) | ✅ | UI |
| Corrupted / unsupported PDFs handled gracefully | ✅ | UI |

## 12. Build & distribution
| Feature | Status | Test |
|---|---|---|
| Code-signing hook (PFX, certificate store / EV token, Azure Trusted Signing) with timestamping | ✅ | M (test certificate) |

## Known limitations
* Paragraph re-flow does not push down the content below a paragraph that grows.
* Signature trust chains are not checked against a root store; self-signed IDs show "identity not verified".
* The released installer is only free of SmartScreen warnings once signed with a CA or Azure Trusted Signing certificate (see docs/CODE_SIGNING.md).
* PDF→Word does not reconstruct tables.
* No cloud service or real-time co-editing (documents stay local by design); reviews are exchanged as XFDF comment files.
* Accessibility: the document check finds problems and fixes metadata/language/title, but does not build a tag structure for untagged PDFs.
* PDF/A output is best-effort and has not been validated with veraPDF.
