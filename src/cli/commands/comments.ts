import { openMupdf, rgbToHex, saveMupdf } from "../../core/mupdf/loader";
import type { Annotation, AnnotationMap, Point, Rect } from "../../core/annotations/types";
import { newId } from "../../core/ids";
import { defineCommand, P, UsageError, WRITES } from "../registry";
import { loadPdf, outputPath, pageGeometries, pageIndex, readBytes, rectToUser, selectPages, toUser, writeAtomic, writePdf, type PdfInput } from "../io";
import { searchDoc } from "../text";

const TYPES = ["highlight", "underline", "strikeout", "note", "freetext", "rect", "ellipse", "line", "arrow", "ink", "image"] as const;
type Kind = (typeof TYPES)[number];

const DEFAULT_COLOR: Record<Kind, string> = {
  highlight: "#ffd400",
  underline: "#d1242f",
  strikeout: "#d1242f",
  note: "#ffd400",
  freetext: "#000000",
  rect: "#d1242f",
  ellipse: "#d1242f",
  line: "#d1242f",
  arrow: "#d1242f",
  ink: "#d1242f",
  image: "#000000",
};

async function bake(input: PdfInput, byPage: Map<number, Annotation[]>, pageCount: number) {
  const { bakeAnnotations } = await import("../../core/annotations/bake");
  const ids = Array.from({ length: pageCount }, (_, i) => String(i));
  const map: AnnotationMap = Object.fromEntries([...byPage].map(([p, l]) => [String(p), l]));
  // Signed files get an incremental update so existing signatures stay valid.
  return bakeAnnotations(input.bytes, ids, map, input.signatures > 0 && !input.password);
}

defineCommand({
  name: "annotations",
  group: "Comments",
  summary: "List comments and markup (highlights, notes, shapes, stamps…) with page, type, text, author and rectangle.",
  readOnly: true,
  params: { input: P.input, pages: P.pages, password: P.password },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const { doc } = await openMupdf(input.bytes);
    try {
      const out = [];
      for (const p of selectPages(a.pages, doc.countPages())) {
        const page = doc.loadPage(p) as import("mupdf").PDFPage;
        for (const an of page.getAnnotations()) {
          const type = an.getType();
          if (type === "Link" || type === "Popup") continue;
          let r: number[];
          try {
            r = an.getRect();
          } catch {
            r = an.getBounds();
          }
          let color: string | undefined;
          try {
            const c = an.getColor();
            color = c.length === 3 ? rgbToHex(c as number[]) : undefined;
          } catch {
            /* no colour */
          }
          let created: string | undefined;
          try {
            created = an.getCreationDate()?.toISOString();
          } catch {
            /* no date */
          }
          out.push({
            page: p + 1,
            type,
            text: an.getContents() || undefined,
            author: an.getAuthor() || undefined,
            created,
            color,
            rect: r.map((v) => Math.round(v * 100) / 100),
          });
        }
      }
      return { count: out.length, annotations: out };
    } finally {
      doc.destroy();
    }
  },
});

function inkPaths(s: string): number[][][] {
  return s
    .split(";")
    .map((stroke) =>
      stroke
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((pt) => {
          const v = pt.split(",").map(Number);
          if (v.length !== 2 || v.some((x) => !Number.isFinite(x))) throw new UsageError(`Bad ink point "${pt}" (expected x,y).`);
          return v;
        }),
    )
    .filter((s) => s.length >= 2);
}

defineCommand({
  name: "annotate",
  group: "Comments",
  summary: "Add a comment or markup: highlight/underline/strikeout found text, sticky note, text box, rectangle, ellipse, line, arrow, freehand ink or image.",
  details:
    "Highlight, underline and strikeout take --find (marks every match; Turkish-aware) or --page with --rect. Notes need --page --at --text; text boxes --page --rect --text; shapes --page --rect; lines/arrows --page --from --to; ink --page --points; images --page --rect --image. Annotations stay editable in Marmara PDF and other PDF readers. On signed files they are added as an incremental update, so signatures stay valid.",
  params: {
    input: P.input,
    type: { type: "string", enum: TYPES, description: "Kind of annotation.", required: true },
    find: { type: "string", description: "Text to mark (highlight/underline/strikeout)." },
    pages: { ...P.pages, description: "Pages searched with --find (default all)." },
    match_case: { type: "boolean", description: "Case-sensitive --find." },
    whole_word: { type: "boolean", description: "Whole-word --find." },
    max_matches: { type: "integer", description: "Mark at most this many matches (default 500).", default: 500 },
    page: { type: "integer", description: "Page number (1-based) for placed annotations." },
    rect: { type: "rect", description: 'Rectangle "x0,y0,x1,y1" (points, top-left origin).' },
    at: { type: "point", description: 'Note position "x,y".' },
    from: { type: "point", description: 'Line/arrow start "x,y".' },
    to: { type: "point", description: 'Line/arrow end "x,y".' },
    points: { type: "string", description: 'Ink strokes: "x,y x,y x,y; x,y x,y" (strokes separated by ";").' },
    text: { type: "string", description: "Note / text-box text, or a comment attached to markup and shapes." },
    color: { type: "string", description: "Colour #rrggbb (defaults per type)." },
    opacity: { type: "number", description: "0–1 (default 1, highlights 0.45)." },
    width: { type: "number", description: "Line width in points (shapes, lines, ink; default 2)." },
    fill: { type: "string", description: "Fill colour for rect/ellipse." },
    font_size: { type: "number", description: "Text-box font size (default 12)." },
    image: { type: "path", description: "PNG/JPEG for type image." },
    author: { type: "string", description: "Author shown in comment lists." },
    ...WRITES,
  },
  examples: [
    'annotate report.pdf --type highlight --find "son tarih"',
    'annotate report.pdf --type note --page 2 --at 500,80 --text "Kontrol et"',
    "annotate plan.pdf --type rect --page 1 --rect 100,200,300,260 --color #2da44e",
  ],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const geoms = await pageGeometries(input.bytes);
    const type = a.type as Kind;
    const base = () => ({
      id: newId(),
      color: (a.color as string) ?? DEFAULT_COLOR[type],
      opacity: (a.opacity as number) ?? (type === "highlight" ? 0.45 : 1),
      createdAt: Date.now(),
      author: a.author as string | undefined,
    });
    const byPage = new Map<number, Annotation[]>();
    const add = (p: number, x: Annotation) => byPage.set(p, [...(byPage.get(p) ?? []), x]);
    const need = (...keys: string[]) => {
      const miss = keys.filter((k) => a[k] === undefined);
      if (miss.length) throw new UsageError(`--type ${type} needs ${miss.map((k) => `--${k.replace(/_/g, "-")}`).join(", ")}.`);
    };
    const pg = () => {
      need("page");
      return pageIndex(a.page, geoms.length);
    };
    const comment = a.text as string | undefined;
    const width = (a.width as number) ?? 2;

    if (type === "highlight" || type === "underline" || type === "strikeout") {
      if (a.find !== undefined) {
        const { doc } = await openMupdf(input.bytes);
        try {
          const { matches, total } = searchDoc(doc, a.find as string, selectPages(a.pages, geoms.length), { matchCase: !!a.match_case, wholeWord: !!a.whole_word }, a.max_matches as number);
          if (!total) return { output: null, added: 0, message: `"${a.find}" was not found.` };
          for (const m of matches) add(m.page - 1, { ...base(), type, rects: m.rects.map((r) => rectToUser(geoms[m.page - 1], r)), text: m.text, comment });
        } finally {
          doc.destroy();
        }
      } else {
        const p = pg();
        need("rect");
        add(p, { ...base(), type, rects: [rectToUser(geoms[p], a.rect as Rect)], text: "", comment });
      }
    } else if (type === "note") {
      const p = pg();
      need("at", "text");
      add(p, { ...base(), type, point: toUser(geoms[p], a.at as Point), text: a.text as string });
    } else if (type === "freetext") {
      const p = pg();
      need("rect", "text");
      add(p, { ...base(), type, rect: rectToUser(geoms[p], a.rect as Rect), text: a.text as string, fontSize: (a.font_size as number) ?? 12 });
    } else if (type === "rect" || type === "ellipse") {
      const p = pg();
      need("rect");
      add(p, { ...base(), type, rect: rectToUser(geoms[p], a.rect as Rect), width, fill: (a.fill as string) ?? null, comment });
    } else if (type === "line" || type === "arrow") {
      const p = pg();
      need("from", "to");
      add(p, { ...base(), type, from: toUser(geoms[p], a.from as Point), to: toUser(geoms[p], a.to as Point), width, comment });
    } else if (type === "ink") {
      const p = pg();
      need("points");
      const paths = inkPaths(a.points as string).map((s) => s.map((pt) => toUser(geoms[p], pt)));
      if (!paths.length) throw new UsageError("--points needs at least one stroke with two points.");
      add(p, { ...base(), type, width, paths, comment });
    } else {
      const p = pg();
      need("rect", "image");
      const img = readBytes(ctx, a.image as string);
      const mime = img[0] === 0x89 && img[1] === 0x50 ? "image/png" : img[0] === 0xff && img[1] === 0xd8 ? "image/jpeg" : null;
      if (!mime) throw new UsageError("--image must be a PNG or JPEG file.");
      add(p, { ...base(), type: "image", rect: rectToUser(geoms[p], a.rect as Rect), dataUrl: `data:${mime};base64,${Buffer.from(img).toString("base64")}`, comment });
    }
    const count = [...byPage.values()].reduce((n, l) => n + l.length, 0);
    const out = await bake(input, byPage, geoms.length);
    return { output: await writePdf(ctx, a, input, out, "annotated"), added: count, pages: [...byPage.keys()].map((p) => p + 1) };
  },
});

defineCommand({
  name: "delete-annotations",
  group: "Comments",
  summary: "Remove comments/markup, optionally only of one type, author or page range.",
  params: {
    input: P.input,
    pages: P.pages,
    type: { type: "string", description: "Only this PDF annotation type, e.g. Highlight, Text (notes), FreeText, Square, Circle, Line, Ink, Stamp, Redact." },
    author: { type: "string", description: "Only annotations by this author." },
    ...WRITES,
  },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const { doc } = await openMupdf(input.bytes);
    try {
      let removed = 0;
      for (const p of selectPages(a.pages, doc.countPages())) {
        const page = doc.loadPage(p) as import("mupdf").PDFPage;
        let changed = false;
        for (const an of [...page.getAnnotations()]) {
          const t = an.getType();
          if (t === "Link" || t === "Popup" || t === "Widget") continue;
          if (a.type && t.toLowerCase() !== String(a.type).toLowerCase()) continue;
          if (a.author && an.getAuthor() !== a.author) continue;
          page.deleteAnnotation(an);
          removed++;
          changed = true;
        }
        if (changed) page.update();
      }
      if (!removed) return { output: null, removed: 0, message: "No matching annotations." };
      const bytes = saveMupdf(doc, input.signatures && !input.password && doc.canBeSavedIncrementally() ? "incremental" : "compress");
      return { output: await writePdf(ctx, a, input, bytes, "cleaned"), removed };
    } finally {
      doc.destroy();
    }
  },
});

defineCommand({
  name: "export-comments",
  group: "Comments",
  summary: "Export the comments made with Marmara PDF to an XFDF file (Acrobat-compatible) for review exchange.",
  params: { input: P.input, output: { ...P.output, description: "XFDF file. Default: <name>.comments.xfdf next to the input." }, overwrite: P.overwrite, password: P.password },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const geoms = await pageGeometries(input.bytes);
    const ids = geoms.map((_, i) => String(i));
    const { importAnnotations } = await import("../../core/annotations/bake");
    const lifted = await importAnnotations(input.bytes, ids);
    if (!lifted) return { output: null, count: 0, message: "No comments made with Marmara PDF were found (other annotations are not exported)." };
    const { exportXfdf } = await import("../../core/annotations/xfdf");
    const xml = exportXfdf(lifted.annotations, ids, input.name);
    const path = outputPath(ctx, a, input.path, "comments", ".xfdf", false);
    writeAtomic(path, new TextEncoder().encode(xml));
    return { output: path, count: lifted.count };
  },
});

defineCommand({
  name: "import-comments",
  group: "Comments",
  summary: "Add the comments from an XFDF file (e.g. from a reviewer or Acrobat) to the PDF.",
  params: { input: P.input, xfdf: { type: "path", description: "XFDF file to import.", required: true }, ...WRITES },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const geoms = await pageGeometries(input.bytes);
    const { importXfdf } = await import("../../core/annotations/xfdf");
    const { byPage, count, skipped } = importXfdf(new TextDecoder().decode(readBytes(ctx, a.xfdf as string)), newId);
    let outside = 0;
    for (const [p, l] of [...byPage]) {
      if (p >= geoms.length) {
        outside += l.length;
        byPage.delete(p);
      }
    }
    if (count - outside <= 0) return { output: null, imported: 0, message: "The file has no comments that fit this document." };
    const out = await bake(input, byPage, geoms.length);
    return { output: await writePdf(ctx, a, input, out, "commented"), imported: count - outside, skipped_unsupported: skipped, skipped_missing_pages: outside };
  },
});
