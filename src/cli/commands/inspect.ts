import { openMupdf } from "../../core/mupdf/loader";
import { defineCommand, P, UsageError } from "../registry";
import { loadPdf, outputPath, rectFromUser, pageGeometries, selectPages, writeAtomic, writePdf } from "../io";
import { pageTextOf, searchDoc } from "../text";
import { newId } from "../../core/ids";

const META = { title: "info:Title", author: "info:Author", subject: "info:Subject", keywords: "info:Keywords", creator: "info:Creator", producer: "info:Producer", created: "info:CreationDate", modified: "info:ModDate" };

defineCommand({
  name: "info",
  group: "Inspect",
  summary: "Page count, page sizes, metadata, encryption, text/scan status, fields, comments, bookmarks and signatures.",
  readOnly: true,
  params: { input: P.input, password: P.password },
  examples: ["info report.pdf"],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const geoms = await pageGeometries(input.bytes);
    const { doc } = await openMupdf(input.bytes);
    try {
      const metadata: Record<string, string> = {};
      for (const [k, key] of Object.entries(META)) {
        const v = doc.getMetaData(key);
        if (v) metadata[k] = v;
      }
      let fields = 0;
      let comments = 0;
      const pages = geoms.map((g, i) => {
        const page = doc.loadPage(i) as import("mupdf").PDFPage;
        const widgets = page.getWidgets().length;
        const annots = page.getAnnotations().length;
        fields += widgets;
        comments += annots;
        const chars = pageTextOf(doc, i).replace(/\s/g, "").length;
        return { page: i + 1, width: Math.round(g.width * 100) / 100, height: Math.round(g.height * 100) / 100, rotation: g.rotation, text_chars: chars, needs_ocr: chars < 12, annotations: annots, form_fields: widgets };
      });
      const { readOutline } = await import("../../core/outline/outline");
      const outline = await readOutline(input.bytes).catch(() => []);
      const countNodes = (l: { children: unknown[] }[]): number => l.reduce((n, x) => n + 1 + countNodes(x.children as never), 0);
      const v = doc.getVersion?.();
      return {
        file: input.path,
        size_bytes: input.bytes.length,
        pdf_version: v ? `${Math.floor(v / 10)}.${v % 10}` : undefined,
        page_count: pages.length,
        encrypted: !!input.password,
        signatures: input.signatures,
        form_fields: fields,
        annotations: comments,
        bookmarks: countNodes(outline),
        language: doc.getLanguage?.() || undefined,
        metadata,
        scanned_pages: pages.filter((p) => p.needs_ocr).map((p) => p.page),
        pages,
        coordinates: "All coordinates used by this tool are points (1/72 inch) from the top-left corner of the page as displayed; y grows downwards.",
      };
    } finally {
      doc.destroy();
    }
  },
});

defineCommand({
  name: "text",
  group: "Inspect",
  summary: "Extract the text of a PDF (per page). Write it to a .txt file with --output.",
  readOnly: false,
  params: {
    input: P.input,
    pages: P.pages,
    output: { type: "path", short: "o", description: "Write the text to this .txt file instead of returning it." },
    overwrite: P.overwrite,
    max_chars: { type: "integer", description: "Truncate the returned text after this many characters (default 50000).", default: 50000 },
    password: P.password,
  },
  examples: ["text report.pdf --pages 1-2", "text report.pdf -o report.txt"],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const { doc } = await openMupdf(input.bytes);
    try {
      const sel = selectPages(a.pages, doc.countPages());
      const pages = sel.map((i) => ({ page: i + 1, text: pageTextOf(doc, i).replace(/\s+$/g, "") }));
      if (a.output) {
        const path = outputPath(ctx, a, input.path, "text", ".txt", false);
        const body = pages.map((p) => p.text).join("\r\n\f\r\n");
        writeAtomic(path, new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(body.replace(/\r?\n/g, "\r\n"))]));
        return { output: path, pages: pages.length, characters: body.length };
      }
      let budget = a.max_chars as number;
      let truncated = false;
      const out = [];
      for (const p of pages) {
        if (budget <= 0) {
          truncated = true;
          break;
        }
        const t = p.text.length > budget ? p.text.slice(0, budget) : p.text;
        if (t.length < p.text.length) truncated = true;
        budget -= t.length;
        out.push({ page: p.page, text: t });
      }
      return { pages: out, truncated };
    } finally {
      doc.destroy();
    }
  },
});

defineCommand({
  name: "search",
  group: "Inspect",
  summary: "Find text (Turkish-aware: İ/ı/I and diacritics match unless match_case). Returns pages, context and rectangles.",
  readOnly: true,
  params: {
    input: P.input,
    query: { type: "string", description: "Text to find.", required: true, positional: true },
    pages: P.pages,
    match_case: { type: "boolean", description: "Case- and diacritic-sensitive search." },
    whole_word: { type: "boolean", description: "Only whole words." },
    max_results: { type: "integer", description: "Maximum matches returned (default 200).", default: 200 },
    password: P.password,
  },
  examples: ['search report.pdf "toplam tutar" --whole-word'],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const { doc } = await openMupdf(input.bytes);
    try {
      const pages = selectPages(a.pages, doc.countPages());
      const { matches, total } = searchDoc(doc, a.query as string, pages, { matchCase: !!a.match_case, wholeWord: !!a.whole_word }, a.max_results as number);
      return { total, returned: matches.length, matches };
    } finally {
      doc.destroy();
    }
  },
});

defineCommand({
  name: "compare",
  group: "Inspect",
  summary: "Compare two versions word by word. Optionally write a marked-up copy of the new version (added text green, removed text as red notes).",
  readOnly: false,
  params: {
    old: { type: "path", description: "Earlier version.", required: true, positional: true },
    new: { type: "path", description: "Later version.", required: true, positional: true },
    output: { type: "path", short: "o", description: "Write a marked-up copy of the new version here." },
    overwrite: P.overwrite,
    max_changes: { type: "integer", description: "Maximum changes listed (default 300).", default: 300 },
    password: P.password,
  },
  examples: ["compare v1.pdf v2.pdf", "compare v1.pdf v2.pdf -o changes.pdf"],
  async run(a, ctx) {
    const oldDoc = await loadPdf(ctx, a.old as string, a.password as string);
    const newDoc = await loadPdf(ctx, a.new as string, a.password as string);
    const { compareDocuments } = await import("../../core/compare/compare");
    ctx.progress("Comparing…");
    const res = await compareDocuments(oldDoc.bytes, newDoc.bytes);
    const geomsNew = await pageGeometries(newDoc.bytes);
    const geomsOld = await pageGeometries(oldDoc.bytes);
    const changes = res.changes.slice(0, a.max_changes as number).map((c) => {
      const w = c.words[0];
      const geoms = c.kind === "inserted" ? geomsNew : geomsOld;
      return {
        kind: c.kind === "inserted" ? "added" : "removed",
        text: c.text,
        page_in_new: c.kind === "inserted" ? (w ? w.page + 1 : undefined) : c.anchor ? c.anchor.page + 1 : undefined,
        page_in_old: c.kind === "deleted" && w ? w.page + 1 : undefined,
        rect: w && geoms[w.page] ? rectFromUser(geoms[w.page], w.rect) : undefined,
      };
    });
    let output: string | undefined;
    if (a.output) {
      if (a.output === a.new) throw new UsageError("Choose an output path different from the new version.");
      const { changesToAnnotations } = await import("../../core/compare/markup");
      const { bakeAnnotations } = await import("../../core/annotations/bake");
      const byPage = changesToAnnotations(res, newId);
      const ids = geomsNew.map((_, i) => String(i));
      const map = Object.fromEntries([...byPage].map(([p, l]) => [String(p), l]));
      const marked = await bakeAnnotations(newDoc.bytes, ids, map);
      output = await writePdf(ctx, a, { ...newDoc, password: undefined }, marked, "compared");
    }
    return {
      identical: res.changes.length === 0,
      added_words: res.insertedWords,
      removed_words: res.deletedWords,
      change_count: res.changes.length,
      pages_old: res.pagesA,
      pages_new: res.pagesB,
      changes,
      truncated: res.changes.length > changes.length,
      output,
    };
  },
});
