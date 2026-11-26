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
| Text inside form XObjects / Type3 fonts | 🟡 shown as not editable | — |
| Paragraph reflow across lines | ⬜ edits are line-based | — |

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

## 6. OCR
| Feature | Status | Test |
|---|---|---|
| Detect scanned pages | ✅ | UI |
| Run OCR (Turkish + English, offline), progress & cancel | ✅ | UI |
| Search recognised text | ✅ | UI |
| Select / copy recognised text (aligned invisible layer) | ✅ | UI |
| Edit recognised text (edit-text tool on OCR layer) | 🟡 edits the invisible layer | M |

## 7. Forms
| Feature | Status | Test |
|---|---|---|
| Fill text, multi-line, checkbox, radio, dropdown/list | ✅ | U, UI |
| Saved with regenerated appearances | ✅ | U, UI |

## 8. File management
| Feature | Status | Test |
|---|---|---|
| Save / Save as | ✅ | UI |
| Original preserved unless overwrite is confirmed | ✅ | M |
| Atomic writes | ✅ | U (Rust) |
| Crash-recovery autosave | ✅ | M |
| Password-protected PDFs (open, edit, save keeps password) | ✅ | UI |
| Corrupted / unsupported PDFs handled gracefully | ✅ | UI |

## Known limitations
* Text edits are per line; no automatic paragraph reflow.
* Digital (certificate) signatures are not implemented; signatures are visual.
* PDF→Word / image conversion is not implemented.
