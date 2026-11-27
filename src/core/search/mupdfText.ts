import { buildPageText, findInPage, rangeToSegments } from "./textSearch";
import type { Rect } from "../annotations/types";
import { round2 } from "../geometry/display";

type MDoc = import("mupdf").PDFDocument;

interface PChar {
  c: string;
  /** Display-space box. */
  box: Rect;
  line: number;
  eol: boolean;
}

/** Characters of a page with display-space boxes (MuPDF structured text). */
export function pageChars(doc: MDoc, index: number): PChar[] {
  const page = doc.loadPage(index);
  const st = page.toStructuredText("preserve-whitespace");
  const chars: PChar[] = [];
  let line = 0;
  try {
    st.walk({
      beginLine() {
        line++;
      },
      endLine() {
        if (chars.length) chars[chars.length - 1].eol = true;
      },
      onChar(c: string, _origin: unknown, _font: unknown, _size: number, q: number[]) {
        const xs = [q[0], q[2], q[4], q[6]];
        const ys = [q[1], q[3], q[5], q[7]];
        chars.push({ c, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], line, eol: false });
      },
    } as never);
  } finally {
    st.destroy?.();
  }
  return chars;
}

export function pageTextOf(doc: MDoc, index: number): string {
  const st = doc.loadPage(index).toStructuredText("preserve-whitespace");
  try {
    return st.asText();
  } finally {
    st.destroy?.();
  }
}

export interface TextMatch {
  page: number;
  text: string;
  context: string;
  /** One rectangle per line the match spans (display coordinates). */
  rects: Rect[];
}

/** Turkish-aware search (İ/ı/I, diacritics, case) over the given pages. */
export function searchDoc(doc: MDoc, query: string, pages: number[], opts: { matchCase: boolean; wholeWord: boolean }, limit = Infinity): { matches: TextMatch[]; total: number } {
  const matches: TextMatch[] = [];
  let total = 0;
  for (const p of pages) {
    const chars = pageChars(doc, p);
    const pt = buildPageText(chars.map((ch) => ({ str: ch.c, hasEOL: ch.eol })), opts.matchCase);
    for (const range of findInPage(pt, query, opts)) {
      total++;
      if (matches.length >= limit) continue;
      const byLine = new Map<number, Rect>();
      for (const seg of rangeToSegments(pt, range)) {
        const ch = chars[seg.item];
        if (!ch || !ch.c.trim()) continue;
        const r = byLine.get(ch.line);
        byLine.set(ch.line, r ? [Math.min(r[0], ch.box[0]), Math.min(r[1], ch.box[1]), Math.max(r[2], ch.box[2]), Math.max(r[3], ch.box[3])] : [...ch.box]);
      }
      const a = Math.max(0, range.start - 40);
      const b = Math.min(pt.raw.length, range.end + 40);
      matches.push({
        page: p + 1,
        text: pt.raw.slice(range.start, range.end),
        context: (a > 0 ? "…" : "") + pt.raw.slice(a, b).replace(/\s+/g, " ").trim() + (b < pt.raw.length ? "…" : ""),
        rects: [...byLine.values()].map((r) => r.map(round2) as Rect),
      });
    }
  }
  return { matches, total };
}
