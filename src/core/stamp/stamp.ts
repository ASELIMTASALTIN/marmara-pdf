import { hexToRgb, invertMatrix, loadMupdf, openMupdf, saveMupdf, transformPoint, type Matrix } from "../mupdf/loader";
import { name, num, str, type Operation } from "../textedit/contentStream";
import { loadPage, op, writeContents } from "../textedit/editor";

type PDFObject = import("mupdf").PDFObject;
const R = (o: PDFObject): PDFObject => (o.isNull() ? o : o.resolve());

/** Marked-content tag of stamps, so they can be replaced or removed. */
export const STAMP_TAG = "MarmaraStamp";

export interface HeaderFooter {
  left?: string;
  center?: string;
  right?: string;
}

export interface StampOptions {
  /** 0-based pages to stamp. */
  pages: number[];
  header?: HeaderFooter;
  footer?: HeaderFooter;
  fontSize?: number;
  color?: string;
  family?: "sans" | "serif" | "mono";
  /** Distance from the page edge in points. */
  margin?: number;
  /** Number shown for the first stamped page ({page}). */
  startNumber?: number;
  bates?: { prefix: string; start: number; digits: number; suffix?: string };
  watermark?: { text: string; size: number; color: string; opacity: number; rotation: number };
  fileName?: string;
  /** Remove earlier stamps on these pages first (default true). */
  replace?: boolean;
}

const FONTS = { sans: "Helvetica", serif: "Times-Roman", mono: "Courier" };

export function expandTokens(t: string, ctx: { page: number; pages: number; bates: string; date: string; file: string }): string {
  return t
    .replace(/\{page\}/g, String(ctx.page))
    .replace(/\{pages\}/g, String(ctx.pages))
    .replace(/\{bates\}/g, ctx.bates)
    .replace(/\{date\}/g, ctx.date)
    .replace(/\{file\}/g, ctx.file);
}

function stripStamps(ops: Operation[]): Operation[] {
  const out: Operation[] = [];
  let depth = 0;
  for (const o of ops) {
    const begin = o.op === "BMC" || o.op === "BDC";
    if (depth) {
      if (begin) depth++;
      else if (o.op === "EMC") depth--;
      continue;
    }
    if (begin && o.operands[0]?.t === "name" && o.operands[0].v === STAMP_TAG) {
      depth = 1;
      continue;
    }
    out.push(o);
  }
  return out;
}

/** Adds headers/footers, page numbers, Bates numbers and/or a text watermark. */
export async function stampPages(bytes: Uint8Array, o: StampOptions): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const { doc } = await openMupdf(bytes);
  try {
    const font = new mupdf.Font(FONTS[o.family ?? "sans"]);
    const fontRef = doc.addFont(font);
    const gs = doc.newDictionary();
    gs.put("Type", doc.newName("ExtGState"));
    gs.put("ca", o.watermark?.opacity ?? 1);
    gs.put("CA", o.watermark?.opacity ?? 1);
    const gsRef = doc.addObject(gs);
    const size = o.fontSize ?? 10;
    const margin = o.margin ?? 28;
    const color = hexToRgb(o.color ?? "#000000");
    const total = doc.countPages();
    const date = new Date().toLocaleDateString("tr-TR");
    const width = (t: string, s: number) => Array.from(t).reduce((w, ch) => w + font.advanceGlyph(Math.max(0, font.encodeCharacter(ch.codePointAt(0)!))) * s, 0);
    const hex = (t: string) => {
      const b: number[] = [];
      for (const ch of Array.from(t)) {
        const g = Math.max(0, font.encodeCharacter(ch.codePointAt(0)!));
        b.push((g >> 8) & 0xff, g & 0xff);
      }
      return Uint8Array.from(b);
    };

    for (let k = 0; k < o.pages.length; k++) {
      const pageIndex = o.pages[k];
      const lp = await loadPage(doc, pageIndex);
      const page = lp.page;
      // MuPDF page space = the page as displayed (rotation applied, origin top-left, y down).
      const bounds = page.getBounds();
      const W = bounds[2] - bounds[0];
      const H = bounds[3] - bounds[1];
      const inv = invertMatrix(page.getTransform() as Matrix);
      const toUser = (x: number, y: number) => transformPoint(inv, x, y);
      const dirOf = (dx: number, dy: number) => {
        const a = toUser(0, 0);
        const b = toUser(dx, dy);
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
      };

      // Resources: font + graphics state.
      let res = lp.pageObj.get("Resources");
      if (res.isNull()) {
        res = doc.newDictionary();
        lp.pageObj.put("Resources", res);
      }
      res = R(res);
      for (const [cat, key, ref] of [
        ["Font", "MPSF", fontRef],
        ["ExtGState", "MPSG", gsRef],
      ] as const) {
        let d = res.get(cat);
        if (d.isNull()) {
          d = doc.newDictionary();
          res.put(cat, d);
        }
        R(d).put(key, ref);
      }

      const ctx = {
        page: (o.startNumber ?? 1) + k,
        pages: total,
        bates: o.bates ? `${o.bates.prefix}${String(o.bates.start + k).padStart(o.bates.digits, "0")}${o.bates.suffix ?? ""}` : "",
        date,
        file: o.fileName ?? "",
      };

      const ops: Operation[] = [op("BMC", name(STAMP_TAG)), op("q")];
      // Text placed at (x, baselineY) in displayed coordinates, reading left-to-right as displayed.
      const place = (text: string, x: number, baselineY: number, s: number, angleDeg = 0, rgb = color) => {
        if (!text) return;
        const a = (angleDeg * Math.PI) / 180;
        const dir = dirOf(Math.cos(a), -Math.sin(a));
        const up = dirOf(-Math.sin(a), -Math.cos(a));
        const origin = toUser(x, baselineY);
        ops.push(
          op("BT"),
          op("Tf", name("MPSF"), num(s)),
          op("rg", ...rgb.map((v) => num(+v.toFixed(4)))),
          op("Tm", ...[dir[0], dir[1], up[0], up[1], origin[0], origin[1]].map((v) => num(+v.toFixed(4)))),
          op("Tj", str(hex(text))),
          op("ET"),
        );
      };

      for (const [hf, yBase] of [
        [o.header, margin + size * 0.8],
        [o.footer, H - margin],
      ] as const) {
        if (!hf) continue;
        const l = expandTokens(hf.left ?? "", ctx);
        const c = expandTokens(hf.center ?? "", ctx);
        const r = expandTokens(hf.right ?? "", ctx);
        place(l, margin, yBase, size);
        place(c, (W - width(c, size)) / 2, yBase, size);
        place(r, W - margin - width(r, size), yBase, size);
      }

      if (o.watermark?.text) {
        const wm = o.watermark;
        const text = expandTokens(wm.text, ctx);
        const tw = width(text, wm.size);
        const a = (wm.rotation * Math.PI) / 180;
        // Centre the rotated text on the page.
        const cx = W / 2 - (Math.cos(a) * tw) / 2 + (Math.sin(a) * wm.size * 0.35);
        const cy = H / 2 + (Math.sin(a) * tw) / 2 + (Math.cos(a) * wm.size * 0.35);
        ops.push(op("gs", name("MPSG")));
        place(text, cx, cy, wm.size, wm.rotation, hexToRgb(wm.color));
      }
      ops.push(op("Q"), op("EMC"));

      const base = o.replace === false ? lp.ops : stripStamps(lp.ops);
      writeContents(doc, lp.pageObj, [op("q"), ...base, op("Q"), ...ops]);
    }
    return saveMupdf(doc, "garbage=compact,compress");
  } finally {
    doc.destroy();
  }
}

/** Removes all headers, footers, numbers and watermarks added by Marmara PDF. */
export async function removeStamps(bytes: Uint8Array): Promise<{ bytes: Uint8Array; pages: number }> {
  const { doc } = await openMupdf(bytes);
  try {
    let pages = 0;
    for (let i = 0; i < doc.countPages(); i++) {
      const lp = await loadPage(doc, i);
      const stripped = stripStamps(lp.ops);
      if (stripped.length !== lp.ops.length) {
        writeContents(doc, lp.pageObj, stripped);
        pages++;
      }
    }
    return { bytes: pages ? saveMupdf(doc, "garbage=compact,compress") : bytes, pages };
  } finally {
    doc.destroy();
  }
}
