import { loadMupdf, openMupdf } from "../mupdf/loader";
import { buildDocx, type DocxItem, type DocxPage, type DocxRun } from "./docx";

/** Supplies a PNG crop of a page region (PDF points, top-left origin), or null to skip images. */
export type ImageProvider = (pageIndex: number, box: { x: number; y: number; w: number; h: number }) => Promise<Uint8Array | null>;

interface SLine {
  bbox: { x: number; y: number; w: number; h: number };
  font: { name: string; family: string; weight: string; style: string; size: number };
  x: number;
  y: number;
  text: string;
}
interface SBlock {
  type: "text" | "image";
  bbox: { x: number; y: number; w: number; h: number };
  lines?: SLine[];
}

const PS_NAMES: [RegExp, string][] = [
  [/times\s*new\s*roman|timesnewroman/i, "Times New Roman"],
  [/^times/i, "Times New Roman"],
  [/arial/i, "Arial"],
  [/helvetica/i, "Arial"],
  [/courier/i, "Courier New"],
  [/calibri/i, "Calibri"],
  [/cambria/i, "Cambria"],
  [/georgia/i, "Georgia"],
  [/verdana/i, "Verdana"],
  [/segoe/i, "Segoe UI"],
];

/** Maps a PDF font name (e.g. "ABCDEF+TimesNewRomanPS-BoldMT") to a Word font name. */
export function wordFontName(pdfName: string, family: string): string {
  const base = pdfName.replace(/^[A-Z]{6}\+/, "").replace(/[-,](Bold|Italic|Oblique|Regular|BoldItalic|BoldOblique|Semibold|Light|Medium|MT|PS).*$/i, "");
  for (const [re, name] of PS_NAMES) if (re.test(base)) return name;
  if (base && base.length < 40) return base.replace(/PSMT$|MT$|PS$/, "");
  return family === "serif" ? "Times New Roman" : family === "monospace" ? "Courier New" : "Calibri";
}

function median(values: number[]): number {
  if (!values.length) return 11;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

/**
 * Image provider rendering the page region with MuPDF (works in the browser and in Node).
 * Renders at 2× (144 DPI) into a pixmap covering only the requested box.
 */
export function mupdfImageProvider(doc: import("mupdf").PDFDocument, mupdf: typeof import("mupdf")): ImageProvider {
  return async (pageIndex, box) => {
    const scale = 2;
    const page = doc.loadPage(pageIndex);
    const m = mupdf.Matrix.scale(scale, scale);
    const rect: [number, number, number, number] = [
      Math.floor(box.x * scale),
      Math.floor(box.y * scale),
      Math.ceil((box.x + box.w) * scale),
      Math.ceil((box.y + box.h) * scale),
    ];
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, rect, false);
    pix.clear(255);
    const dev = new mupdf.DrawDevice(m, pix);
    try {
      page.runPageContents(dev, mupdf.Matrix.identity);
      dev.close();
      return pix.asPNG().slice();
    } finally {
      dev.destroy?.();
      pix.destroy?.();
    }
  };
}

/**
 * Converts a PDF to an editable Word document. Text blocks become paragraphs
 * (fonts, sizes, bold/italic, alignment kept); images are embedded; each PDF
 * page becomes a section with the same page size.
 */
export async function pdfToDocx(
  bytes: Uint8Array,
  title: string,
  imageOption: ImageProvider | "render" | null,
  onProgress?: (page: number, total: number) => void,
): Promise<Uint8Array> {
  const { doc } = await openMupdf(bytes);
  const images = imageOption === "render" ? mupdfImageProvider(doc, await loadMupdf()) : imageOption;
  try {
    const n = doc.countPages();
    const parsed: { w: number; h: number; blocks: SBlock[] }[] = [];
    const sizes: number[] = [];
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      const b = page.getBounds();
      const st = page.toStructuredText("preserve-spans,preserve-images,dehyphenate");
      const json = JSON.parse(st.asJSON()) as { blocks: SBlock[] };
      st.destroy?.();
      for (const bl of json.blocks) for (const l of bl.lines ?? []) sizes.push(Math.round(l.font.size));
      parsed.push({ w: b[2] - b[0], h: b[3] - b[1], blocks: json.blocks });
    }
    const body = median(sizes);

    const pages: DocxPage[] = [];
    for (let i = 0; i < parsed.length; i++) {
      onProgress?.(i, parsed.length);
      const { w, h, blocks } = parsed[i];
      const items: DocxItem[] = [];
      let prevBottom = 0;
      for (const bl of blocks) {
        if (bl.type === "image") {
          if (!images || bl.bbox.w < 8 || bl.bbox.h < 8) continue;
          const png = await images(i, bl.bbox);
          if (png) {
            const center = Math.abs(bl.bbox.x + bl.bbox.w / 2 - w / 2) < w * 0.08;
            items.push({ kind: "img", png, widthPt: bl.bbox.w, heightPt: bl.bbox.h, align: center ? "center" : "left" });
          }
          prevBottom = bl.bbox.y + bl.bbox.h;
          continue;
        }
        const lines = bl.lines ?? [];
        if (!lines.length) continue;
        // Group spans into visual lines, then the block into one paragraph.
        const runs: DocxRun[] = [];
        let lastY: number | null = null;
        let lastEnd = 0;
        for (const l of lines) {
          const text = l.text;
          if (!text) continue;
          const sameLine = lastY !== null && Math.abs(l.y - lastY) < l.font.size * 0.4;
          if (runs.length) {
            const prev = runs[runs.length - 1];
            const gap = l.bbox.x - lastEnd;
            const needsSpace = sameLine ? gap > l.font.size * 0.15 : true;
            if (needsSpace && !/\s$/.test(prev.text) && !/^\s/.test(text)) {
              if (!sameLine && /-$/.test(prev.text) && /^[a-zà-ÿçğıöşü]/.test(text)) prev.text = prev.text.slice(0, -1);
              else prev.text += " ";
            }
          }
          const bold = l.font.weight === "bold" || /bold|black|heavy|semibold/i.test(l.font.name);
          const italic = l.font.style === "italic" || /italic|oblique/i.test(l.font.name);
          const font = wordFontName(l.font.name, l.font.family);
          const size = Math.round(l.font.size * 2) / 2;
          const prev = runs[runs.length - 1];
          if (prev && prev.bold === bold && prev.italic === italic && prev.font === font && prev.size === size) prev.text += text;
          else runs.push({ text, bold, italic, font, size });
          lastY = l.y;
          lastEnd = l.bbox.x + l.bbox.w;
        }
        if (!runs.length) continue;
        const bx = bl.bbox;
        const centered = Math.abs(bx.x + bx.w / 2 - w / 2) < w * 0.04 && bx.w < w * 0.7;
        const rightAligned = !centered && bx.x > w * 0.55 && bx.x + bx.w > w * 0.85;
        const gapBefore = Math.max(0, bx.y - prevBottom);
        if (items.length && gapBefore > body * 2.5) items.push({ kind: "p", runs: [{ text: "" }], spaceAfterPt: Math.min(gapBefore - body * 1.5, 48) });
        const maxSize = Math.max(...runs.map((r) => r.size ?? body));
        items.push({
          kind: "p",
          runs,
          align: centered ? "center" : rightAligned ? "right" : "left",
          spaceAfterPt: maxSize > body * 1.2 ? 8 : 4,
          indentPt: centered || rightAligned ? 0 : Math.max(0, bx.x - 72),
        });
        prevBottom = bx.y + bx.h;
      }
      pages.push({ widthPt: w, heightPt: h, items });
    }
    return buildDocx(pages, title);
  } finally {
    doc.destroy();
  }
}

/** Plain text of every page (pages separated by a form feed). */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const { doc } = await openMupdf(bytes);
  try {
    const out: string[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const st = doc.loadPage(i).toStructuredText("dehyphenate");
      out.push(st.asText().replace(/\s+$/, ""));
      st.destroy?.();
    }
    return out.join("\n\f\n") + "\n";
  } finally {
    doc.destroy();
  }
}
