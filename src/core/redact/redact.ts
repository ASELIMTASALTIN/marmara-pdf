import type { Rect } from "../annotations/types";
import { invertMatrix, openMupdf, saveMupdf, transformPoint, type Matrix } from "../mupdf/loader";

/**
 * True redaction: content under the marked areas is *removed* from the file
 * (text, image pixels and covered vector graphics), not merely covered.
 */

export interface RedactionArea {
  pageIndex: number;
  /** PDF user-space rectangles. */
  rects: Rect[];
}

export interface RedactOptions {
  /** Draw black boxes where content was removed (otherwise leave white space). */
  blackBoxes: boolean;
  /** Also clear document metadata (title, author, subject, keywords, XMP). */
  removeMetadata: boolean;
}

/** Applies redactions and returns the cleaned PDF (fully rewritten, no old revisions). */
export async function applyRedactions(bytes: Uint8Array, areas: RedactionArea[], opts: RedactOptions): Promise<Uint8Array> {
  const { mupdf, doc } = await openMupdf(bytes);
  try {
    for (const area of areas) {
      if (!area.rects.length) continue;
      const page = doc.loadPage(area.pageIndex) as import("mupdf").PDFPage;
      const ctm = page.getTransform() as Matrix;
      for (const r of area.rects) {
        const a = transformPoint(ctm, r[0], r[1]);
        const b = transformPoint(ctm, r[2], r[3]);
        const annot = page.createAnnotation("Redact");
        annot.setRect([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
        annot.update();
      }
      page.applyRedactions(
        opts.blackBoxes,
        mupdf.PDFPage.REDACT_IMAGE_PIXELS,
        mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
        mupdf.PDFPage.REDACT_TEXT_REMOVE,
      );
      page.update();
    }
    if (opts.removeMetadata) {
      for (const key of ["info:Title", "info:Author", "info:Subject", "info:Keywords", "info:Creator", "info:Producer"]) doc.setMetaData(key, "");
      const root = doc.getTrailer().get("Root").resolve();
      root.delete("Metadata");
    }
    // A full rewrite with garbage collection drops the old, unredacted objects.
    return saveMupdf(doc, "garbage=compact,compress");
  } finally {
    doc.destroy();
  }
}

/** Finds all occurrences of `query` and returns their areas in PDF user space. */
export async function findTextAreas(bytes: Uint8Array, query: string, wholeWord = false): Promise<RedactionArea[]> {
  if (!query.trim()) return [];
  const { doc } = await openMupdf(bytes);
  try {
    const out: RedactionArea[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i) as import("mupdf").PDFPage;
      const inv = invertMatrix(page.getTransform() as Matrix);
      let hits = page.search(query, {}) as unknown as number[][][];
      if (wholeWord) {
        const st = page.toStructuredText("preserve-whitespace");
        const text = st.asText();
        st.destroy?.();
        const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}_])`, "giu");
        if (!re.test(text)) hits = [];
      }
      const rects: Rect[] = [];
      for (const hit of hits) {
        for (const q of hit) {
          // quad: ul, ur, ll, lr (8 numbers) in MuPDF page space
          const pts = [0, 2, 4, 6].map((k) => transformPoint(inv, q[k], q[k + 1]));
          const xs = pts.map((p) => p[0]);
          const ys = pts.map((p) => p[1]);
          rects.push([Math.min(...xs) - 0.5, Math.min(...ys) - 0.5, Math.max(...xs) + 0.5, Math.max(...ys) + 0.5]);
        }
      }
      if (rects.length) out.push({ pageIndex: i, rects });
    }
    return out;
  } finally {
    doc.destroy();
  }
}
