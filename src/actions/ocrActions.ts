import { TEXT_CONTENT_OPTIONS, type PDFDocumentProxy } from "../core/pdf/pdfjs";
import { parsePageRanges } from "../core/pdf/pageOps";
import type { OcrLanguage, OcrLine } from "../core/ocr/recognize";
import type { OcrLineGeom } from "../core/ocr/textLayer";
import type { Point } from "../core/annotations/types";
import { commit, exclusive, setBusyLabel, useDoc, withBusy } from "../state/documentStore";
import { useUi } from "../state/uiStore";
import { errorMessage, openDialog, toast } from "../state/dialogStore";

const OCR_TAG = "MarmaraOCR";
const LANG_KEY = "marmara.ocrLang";

export interface PageTextStatus {
  /** Characters of real (non-OCR) text on the page. */
  realChars: number;
  hasOcrLayer: boolean;
}

/** Classifies a page: scanned pages have (almost) no real text. */
export async function pageTextStatus(pdf: PDFDocumentProxy, index: number): Promise<PageTextStatus> {
  const page = await pdf.getPage(index + 1);
  const tc = await page.getTextContent(TEXT_CONTENT_OPTIONS);
  let realChars = 0;
  let hasOcrLayer = false;
  const stack: boolean[] = [];
  for (const it of tc.items as { str?: string; type?: string; tag?: string }[]) {
    if (it.type === "beginMarkedContent" || it.type === "beginMarkedContentProps") {
      const isOcr = it.tag === OCR_TAG;
      if (isOcr) hasOcrLayer = true;
      stack.push(isOcr || stack[stack.length - 1] === true);
    } else if (it.type === "endMarkedContent") stack.pop();
    else if (typeof it.str === "string" && !stack[stack.length - 1]) realChars += it.str.replace(/\s/g, "").length;
  }
  return { realChars, hasOcrLayer };
}

export const needsOcr = (s: PageTextStatus) => s.realChars < 12;

function unit(a: Point, b: Point): Point {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

/** Converts recognised pixel lines to PDF-space line geometry. */
function toGeometry(lines: OcrLine[], vp: { convertToPdfPoint(x: number, y: number): number[]; scale: number }): OcrLineGeom[] {
  const P = (x: number, y: number) => vp.convertToPdfPoint(x, y) as Point;
  const s = vp.scale;
  return lines.map((l) => {
    const first = l.words[0];
    const slope = (l.baseline[1] - l.baseline[0]) / Math.max(1, l.x1 - l.x0);
    const baseAt = (x: number) => l.baseline[0] + slope * (x - l.x0);
    const by = baseAt(first.x0);
    // Size from the ascent above the baseline (cap/ascender height ≈ 0.72 em).
    const ascentPx = Math.max(4, by - l.y0);
    return {
      origin: P(first.x0, by),
      dir: unit(P(first.x0, by), P(first.x0 + 100, by)),
      up: unit(P(first.x0, by), P(first.x0, by - 100)),
      size: ascentPx / 0.72 / s,
      words: l.words.map((w) => ({ text: w.text, start: (w.x0 - first.x0) / s, width: (w.x1 - w.x0) / s })),
    };
  });
}

/** Renders a page for OCR at ~300 DPI (bounded to keep memory reasonable). */
async function renderForOcr(pdf: PDFDocumentProxy, index: number) {
  const page = await pdf.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(300 / 72, 4200 / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport }).promise;
  return { canvas, viewport };
}

export async function runOcr(pages: number[], lang: OcrLanguage): Promise<void> {
  if (!pages.length) return;
  let cancelled = false;
  await exclusive(async () => {
    const { pdf, doc } = useDoc.getState();
    if (!pdf || !doc) return;
    const startBytes = doc.bytes;
    try {
      const { recognizeAuto } = await import("../core/ocr/recognize");
      const { addOcrTextLayers } = await import("../core/ocr/textLayer");
      const results: { pageIndex: number; lines: OcrLineGeom[] }[] = [];
      let words = 0;
      await withBusy(
        "Preparing text recognition…",
        async () => {
          for (let k = 0; k < pages.length && !cancelled; k++) {
            const i = pages[k];
            const label = `Recognising text — page ${i + 1} (${k + 1} of ${pages.length})`;
            setBusyLabel(label);
            const { canvas, viewport } = await renderForOcr(pdf, i);
            const { lines } = await recognizeAuto(canvas, lang, (p) => setBusyLabel(`${label} — ${Math.round(p * 100)}%`));
            canvas.width = canvas.height = 0; // free memory early
            words += lines.reduce((n, l) => n + l.words.length, 0);
            results.push({ pageIndex: i, lines: toGeometry(lines, viewport) });
          }
          if (cancelled || !results.length) return;
          setBusyLabel("Adding the recognised text layer…");
          const bytes = await addOcrTextLayers(startBytes, results);
          if (useDoc.getState().doc?.bytes !== startBytes) throw new Error("The document changed during recognition.");
          await commit(results.length > 1 ? `Recognise text (${results.length} pages)` : "Recognise text", { bytes });
        },
        () => (cancelled = true),
      );
      if (cancelled) toast("Text recognition cancelled", "info");
      else if (results.length)
        toast(
          words
            ? `Recognised ${words} words on ${results.length} page${results.length > 1 ? "s" : ""}. The text is now searchable and selectable.`
            : "No text was found on the selected pages.",
          words ? "success" : "info",
          6000,
        );
    } catch (e) {
      toast(`Text recognition failed: ${errorMessage(e)}`, "error");
    }
  });
}

/** OCR dialog: choose pages and language, then run. */
export async function ocrDialog(): Promise<void> {
  const { pdf, pageSizes } = useDoc.getState();
  if (!pdf) return;
  const n = pageSizes.length;
  const statuses = await withBusy("Checking pages…", async () => {
    const out: PageTextStatus[] = [];
    for (let i = 0; i < n; i++) out.push(await pageTextStatus(pdf, i).catch(() => ({ realChars: 0, hasOcrLayer: false })));
    return out;
  });
  const scanned = statuses.map((s, i) => (needsOcr(s) ? i : -1)).filter((i) => i >= 0);
  const current = useUi.getState().currentPage;
  const currentHasText = !needsOcr(statuses[current]);
  const r = await openDialog({
    title: "Recognise text (OCR)",
    message: scanned.length
      ? `${scanned.length} of ${n} page${n > 1 ? "s" : ""} look scanned (no selectable text). Recognised text is added as an invisible layer, so the page looks the same but becomes searchable and selectable.`
      : "All pages already contain text. OCR is only useful for scanned pages or text drawn as images.",
    fields: [
      {
        kind: "radio",
        key: "pages",
        label: "Pages",
        value: scanned.length ? "scanned" : "current",
        options: [
          ...(scanned.length ? [{ value: "scanned", label: `Pages without text (${scanned.length})` }] : []),
          { value: "current", label: `Current page (${current + 1})`, hint: currentHasText ? "This page already has text" : undefined },
          { value: "all", label: `All pages (${n})` },
          { value: "range", label: "Page range…" },
        ],
      },
      { kind: "text", key: "range", label: "Range (when “Page range” is chosen)", placeholder: `e.g. 1-3, 7`, value: "" },
      {
        kind: "select",
        key: "lang",
        label: "Document language",
        value: localStorage.getItem(LANG_KEY) || "tur+eng",
        options: [
          { value: "tur+eng", label: "Turkish + English (automatic)" },
          { value: "tur", label: "Turkish" },
          { value: "eng", label: "English" },
        ],
      },
    ],
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Recognise text", variant: "primary" },
    ],
    validate: (v, b) => {
      if (b !== "ok" || v.pages !== "range") return null;
      try {
        parsePageRanges(v.range, n);
        return null;
      } catch (e) {
        return errorMessage(e);
      }
    },
  });
  if (r.button !== "ok") return;
  localStorage.setItem(LANG_KEY, r.values.lang);
  let pages: number[];
  switch (r.values.pages) {
    case "scanned":
      pages = scanned;
      break;
    case "current":
      pages = [current];
      break;
    case "all":
      pages = Array.from({ length: n }, (_, i) => i);
      break;
    default:
      pages = [...new Set(parsePageRanges(r.values.range, n))];
  }
  // Pages with real text would get duplicate text: skip them unless explicitly the current page.
  const withText = pages.filter((i) => !needsOcr(statuses[i]));
  if (withText.length && r.values.pages !== "current") {
    pages = pages.filter((i) => needsOcr(statuses[i]));
    if (!pages.length) {
      toast("The selected pages already contain text; nothing to recognise.", "info");
      return;
    }
    toast(`Skipping ${withText.length} page${withText.length > 1 ? "s" : ""} that already contain text`, "info");
  }
  await runOcr(pages, r.values.lang as OcrLanguage);
}
