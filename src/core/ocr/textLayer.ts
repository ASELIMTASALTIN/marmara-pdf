import type { Point } from "../annotations/types";
import { openMupdf, saveMupdf } from "../mupdf/loader";
import { name, num, str, type Operation, type PdfValue } from "../textedit/contentStream";
import { addBuiltinFont, loadPage, op, writeContents } from "../textedit/editor";

/** Marked-content tag wrapping the invisible OCR text, so a re-run can replace it. */
export const OCR_TAG = "MarmaraOCR";

/** One recognised line, already converted to PDF user space. */
export interface OcrLineGeom {
  /** Baseline start of the first word. */
  origin: Point;
  /** Unit vectors (user space) of the reading direction and "up". */
  dir: Point;
  up: Point;
  /** Font size in user units. */
  size: number;
  /** Words with their start offset and width along `dir`, relative to origin (user units). */
  words: { text: string; start: number; width: number }[];
}

/** Removes a previous OCR layer (content between `/MarmaraOCR BMC` and its `EMC`). */
function stripOcr(ops: Operation[]): Operation[] {
  const out: Operation[] = [];
  let depth = 0;
  let skipping = 0;
  for (const o of ops) {
    const isBegin = o.op === "BMC" || o.op === "BDC";
    if (skipping) {
      if (isBegin) depth++;
      else if (o.op === "EMC") {
        depth--;
        if (depth === 0) skipping = 0;
      }
      continue;
    }
    if (isBegin && o.operands[0]?.t === "name" && o.operands[0].v === OCR_TAG) {
      skipping = 1;
      depth = 1;
      continue;
    }
    out.push(o);
  }
  return out;
}

/**
 * Adds recognised text to pages as an invisible (render mode 3) text layer
 * aligned with the scanned image — searchable, selectable and copyable,
 * without changing the page's appearance.
 */
export async function addOcrTextLayers(bytes: Uint8Array, pages: { pageIndex: number; lines: OcrLineGeom[] }[]): Promise<Uint8Array> {
  const { doc } = await openMupdf(bytes);
  try {
    for (const { pageIndex, lines } of pages) {
      const lp = await loadPage(doc, pageIndex);
      const base = stripOcr(lp.ops);
      if (!lines.length) {
        writeContents(doc, lp.pageObj, base);
        continue;
      }
      const { font, key } = await addBuiltinFont(doc, lp.pageObj, "Helvetica");
      const gidOf = (ch: string) => Math.max(0, font.encodeCharacter(ch.codePointAt(0)!));
      const advance = (text: string, size: number) =>
        Array.from(text).reduce((w, ch) => w + font.advanceGlyph(gidOf(ch)) * size, 0);
      const enc = (text: string) => {
        const out: number[] = [];
        for (const ch of Array.from(text)) {
          const g = gidOf(ch);
          out.push((g >> 8) & 0xff, g & 0xff);
        }
        return Uint8Array.from(out);
      };

      const layer: Operation[] = [op("BMC", name(OCR_TAG)), op("q"), op("BT"), op("Tr", num(3))];
      for (const line of lines) {
        const size = Math.max(1, +line.size.toFixed(2));
        // Horizontal scaling so the font's natural word widths match the recognised boxes.
        const natural = line.words.reduce((n, w) => n + advance(w.text, size), 0);
        const target = line.words.reduce((n, w) => n + w.width, 0);
        const th = Math.min(3, Math.max(0.3, natural > 0 ? target / natural : 1));
        layer.push(
          op("Tf", name(key), num(size)),
          op("Tz", num(+(th * 100).toFixed(2))),
          op(
            "Tm",
            ...[line.dir[0], line.dir[1], line.up[0], line.up[1], line.origin[0], line.origin[1]].map((v) => num(+v.toFixed(4))),
          ),
        );
        // One TJ per line: words separated by real space glyphs; kerning places each word
        // exactly at its recognised position (TJ numbers are in 1/1000 em, scaled by Tz).
        const kern = (dist: number) => num(+((-dist * 1000) / (size * th)).toFixed(1));
        const items: PdfValue[] = [];
        let pos = 0; // current pen position along the line (user units)
        const spaceAdv = advance(" ", size) * th;
        line.words.forEach((w, i) => {
          if (i > 0) {
            items.push(str(enc(" ")));
            pos += spaceAdv;
          }
          const gap = w.start - pos;
          if (Math.abs(gap) > 0.01) items.push(kern(gap));
          pos = w.start;
          items.push(str(enc(w.text)));
          pos += advance(w.text, size) * th;
        });
        layer.push(op("TJ", { t: "arr", v: items }));
      }
      layer.push(op("ET"), op("Q"), op("EMC"));
      writeContents(doc, lp.pageObj, [op("q"), ...base, op("Q"), ...layer]);
    }
    return saveMupdf(doc, "compress");
  } finally {
    doc.destroy();
  }
}
