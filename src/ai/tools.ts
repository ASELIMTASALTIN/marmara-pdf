/**
 * Tools the assistant can use on the document that is open in Marmara PDF.
 * Every change goes through the normal document store, so it appears
 * immediately and can be undone (Ctrl+Z) like a manual edit.
 *
 * The parameters are deliberately simple (page numbers, phrases, named
 * positions) so a small local model can call them reliably.
 */
import type { Annotation, AnnotationMap } from "../core/annotations/types";
import { countAnnotations } from "../core/annotations/types";
import { newId } from "../core/ids";
import { dirToUser, pageGeometries, rectToUser, toUser, type PageGeom } from "../core/geometry/display";
import { openMupdf } from "../core/mupdf/loader";
import { parsePageRanges } from "../core/pdf/pageOps";
import { commit, exclusive, useDoc } from "../state/documentStore";
import { useUi } from "../state/uiStore";
import { viewer } from "../components/viewer/viewerController";
import type { ToolSpec } from "./client";

export interface ToolResult {
  ok: boolean;
  [key: string]: unknown;
}

interface Tool {
  spec: ToolSpec;
  /** Short description for the chat (e.g. "Highlighted 8 × “tarih”"). */
  describe: (args: Args, result: ToolResult) => string;
  run: (args: Args) => Promise<ToolResult>;
}

type Args = Record<string, unknown>;

// ---------- helpers ----------

function currentDoc() {
  const d = useDoc.getState().doc;
  if (!d) throw new Error("No document is open.");
  return d;
}

const pageCount = () => currentDoc().pageIds.length;

function pageIndex(v: unknown): number {
  const n = pageCount();
  if (v === undefined || v === null || v === "") return useUi.getState().currentPage;
  const s = String(v).trim().toLowerCase();
  const p = /^(last|son)$/.test(s) ? n : Number.parseInt(s, 10);
  if (!Number.isInteger(p) || p < 1 || p > n) throw new Error(`Page ${v} does not exist; the document has ${n} page${n === 1 ? "" : "s"}.`);
  return p - 1;
}

function pageList(v: unknown, fallback: "current" | "all"): number[] {
  const n = pageCount();
  const all = Array.from({ length: n }, (_, i) => i);
  if (v === undefined || v === null || v === "") return fallback === "all" ? all : [useUi.getState().currentPage];
  if (typeof v === "number") return [pageIndex(v)];
  if (Array.isArray(v)) return v.map(pageIndex);
  const s = String(v).trim().toLowerCase();
  if (/^(all|tümü|tüm|hepsi|every)$/.test(s)) return all;
  if (/^(current|this|bu)$/.test(s)) return [useUi.getState().currentPage];
  return [...new Set(parsePageRanges(s.replace(/\b(last|son)\b/g, String(n)), n))];
}

const geomCache = new WeakMap<Uint8Array, PageGeom[]>();
async function geoms(): Promise<PageGeom[]> {
  const bytes = currentDoc().bytes;
  let g = geomCache.get(bytes);
  if (!g) {
    g = await pageGeometries(bytes);
    geomCache.set(bytes, g);
  }
  return g;
}

async function withMupdf<T>(fn: (doc: import("mupdf").PDFDocument) => T | Promise<T>): Promise<T> {
  const { doc } = await openMupdf(currentDoc().bytes);
  try {
    return await fn(doc);
  } finally {
    doc.destroy();
  }
}

/** Runs a change exclusively and records it as one undo step. */
function change<T>(fn: () => Promise<T>): Promise<T> {
  return exclusive(fn);
}

const label = (s: string) => `Assistant: ${s}`;

const COLORS: Record<string, string> = { yellow: "#ffd400", green: "#7ee787", blue: "#58a6ff", pink: "#ff7eb6", red: "#ff4d4f", orange: "#ffa657" };
const color = (v: unknown, fallback: string) => {
  const s = String(v ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  return COLORS[s] ?? fallback;
};

const POSITIONS = ["top-left", "top-center", "top-right", "center", "bottom-left", "bottom-center", "bottom-right"] as const;

/** Top-left corner (display coordinates) for a box of size w×h at a named position. */
function placeAt(g: PageGeom, position: unknown, w: number, h: number, margin = 36): [number, number] {
  const pos = String(position ?? "top-left");
  const x = pos.endsWith("right") ? g.width - margin - w : pos.endsWith("center") || pos === "center" ? (g.width - w) / 2 : margin;
  const y = pos.startsWith("bottom") ? g.height - margin - h : pos === "center" ? (g.height - h) / 2 : margin;
  return [Math.max(4, x), Math.max(4, y)];
}

async function addAnnotations(byPage: Map<number, Annotation[]>, what: string) {
  await change(async () => {
    const { doc, annotations } = useDoc.getState();
    if (!doc) return;
    const next: AnnotationMap = { ...annotations };
    for (const [p, list] of byPage) {
      const id = doc.pageIds[p];
      if (id) next[id] = [...(next[id] ?? []), ...list];
    }
    await commit(label(what), { annotations: next });
  });
}

async function search(query: string, pages: number[], wholeWord = false) {
  const { searchDoc } = await import("../core/search/mupdfText");
  return withMupdf((d) => searchDoc(d, query, pages, { matchCase: false, wholeWord }, 300));
}

const str = (v: unknown, name: string) => {
  const s = typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
  if (!s.trim()) throw new Error(`"${name}" is required.`);
  return s;
};

function spec(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSpec {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const PAGES = { type: "string", description: 'Pages, 1-based: "3", "1-4", "2,5", "all".' };
const PAGE = { type: "integer", description: "Page number (1-based). Default: the page the user is viewing." };

// ---------- tools ----------

export const TOOLS: Tool[] = [
  {
    spec: spec("get_document_info", "Facts about the open PDF: name, page count, current page, title, form fields, comments, bookmarks, scanned pages.", {}),
    describe: (_a, r) => `Looked at the document (${r.page_count} pages)`,
    async run() {
      const d = currentDoc();
      const st = useDoc.getState();
      const { pageTextOf } = await import("../core/search/mupdfText");
      const info = await withMupdf((m) => {
        const scanned: number[] = [];
        let fields = 0;
        const n = m.countPages();
        for (let i = 0; i < n; i++) {
          if (i < 60 && pageTextOf(m, i).replace(/\s/g, "").length < 12) scanned.push(i + 1);
          fields += (m.loadPage(i) as import("mupdf").PDFPage).getWidgets().length;
        }
        return { title: m.getMetaData("info:Title") || undefined, author: m.getMetaData("info:Author") || undefined, scanned, fields };
      });
      const { readOutline } = await import("../core/outline/outline");
      const outline = await readOutline(d.bytes).catch(() => []);
      return {
        ok: true,
        file: d.name,
        page_count: d.pageIds.length,
        current_page: useUi.getState().currentPage + 1,
        title: info.title,
        author: info.author,
        form_fields: info.fields,
        comments: countAnnotations(st.annotations),
        bookmarks: outline.length,
        pages_without_text: info.scanned,
        digitally_signed: !!d.signatures,
        unsaved_changes: st.dirty,
      };
    },
  },
  {
    spec: spec("read_text", "Read the text of pages (to answer questions, summarise or translate). Default: the current page.", { pages: PAGES }),
    describe: (a, r) => `Read ${r.pages_read ?? a.pages ?? "the current page"}`,
    async run(a) {
      const pages = pageList(a.pages, "current");
      const { pageTextOf } = await import("../core/search/mupdfText");
      const LIMIT = 6000;
      let used = 0;
      const out: { page: number; text: string }[] = [];
      let truncated = false;
      await withMupdf((m) => {
        for (const p of pages) {
          if (used >= LIMIT) {
            truncated = true;
            break;
          }
          let t = pageTextOf(m, p).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
          if (used + t.length > LIMIT) {
            t = t.slice(0, LIMIT - used) + " …";
            truncated = true;
          }
          used += t.length;
          out.push({ page: p + 1, text: t || "(no text on this page — it may be a scan; OCR can recognise it)" });
        }
      });
      const first = out[0]?.page;
      const last = out[out.length - 1]?.page;
      return { ok: true, pages_read: first === last ? `page ${first}` : `pages ${first}–${last}`, text: out, truncated: truncated || undefined };
    },
  },
  {
    spec: spec("find_text", "Find where a word or phrase occurs (case- and accent-insensitive).", { query: { type: "string", description: "Text to find." } }, ["query"]),
    describe: (a, r) => `Found ${r.total} × “${a.query}”`,
    async run(a) {
      const { matches, total } = await search(str(a.query, "query"), pageList("all", "all"));
      return { ok: true, total, matches: matches.slice(0, 8).map((m) => ({ page: m.page, context: m.context })) };
    },
  },
  {
    spec: spec(
      "highlight_text",
      "Highlight (vurgula), underline (altını çiz) or strike out (üstünü çiz) every occurrence of a word or phrase. Not for hiding text: use mark_for_redaction for that.",
      {
        query: { type: "string", description: "Text to mark." },
        color: { type: "string", enum: Object.keys(COLORS), description: "Default yellow." },
        style: { type: "string", enum: ["highlight", "underline", "strikeout"], description: "Default highlight." },
        pages: { ...PAGES, description: PAGES.description + " Default: all." },
      },
      ["query"],
    ),
    describe: (a, r) => `${r.style === "underline" ? "Underlined" : r.style === "strikeout" ? "Struck out" : "Highlighted"} ${r.marked} × “${a.query}”`,
    async run(a) {
      const query = str(a.query, "query");
      const style = (["highlight", "underline", "strikeout"].includes(String(a.style)) ? a.style : "highlight") as "highlight" | "underline" | "strikeout";
      const { matches, total } = await search(query, pageList(a.pages, "all"));
      if (!total) return { ok: false, error: `“${query}” does not occur in the document.` };
      const g = await geoms();
      const byPage = new Map<number, Annotation[]>();
      for (const m of matches) {
        const p = m.page - 1;
        const ann: Annotation = {
          id: newId(),
          type: style,
          rects: m.rects.map((r) => rectToUser(g[p], r)),
          text: m.text,
          color: color(a.color, style === "highlight" ? COLORS.yellow : COLORS.red),
          opacity: style === "highlight" ? 0.45 : 1,
          createdAt: Date.now(),
          author: "Marmara Assistant",
        };
        byPage.set(p, [...(byPage.get(p) ?? []), ann]);
      }
      await addAnnotations(byPage, `${style} “${query}”`);
      return { ok: true, style, marked: matches.length, pages: [...byPage.keys()].map((p) => p + 1) };
    },
  },
  {
    spec: spec(
      "add_comment",
      "Add a sticky-note comment (yorum, not) to a page.",
      { text: { type: "string", description: "Comment text." }, page: PAGE, position: { type: "string", enum: [...POSITIONS], description: "Default top-right." } },
      ["text"],
    ),
    describe: (_a, r) => `Added a comment on page ${r.page}`,
    async run(a) {
      const text = str(a.text, "text");
      const p = pageIndex(a.page);
      const g = (await geoms())[p];
      const [x, y] = placeAt(g, a.position ?? "top-right", 24, 24, 24);
      await addAnnotations(
        new Map([[p, [{ id: newId(), type: "note", point: toUser(g, [x, y]), text, color: "#ffd400", opacity: 1, createdAt: Date.now(), author: "Marmara Assistant" } as Annotation]]]),
        "comment",
      );
      return { ok: true, page: p + 1 };
    },
  },
  {
    spec: spec(
      "replace_text",
      "Change or correct existing text in the PDF itself (değiştir, düzelt; real content edit, not an overlay): replaces every occurrence.",
      { find: { type: "string", description: "Existing text." }, replace: { type: "string", description: "New text (empty to delete)." } },
      ["find", "replace"],
    ),
    describe: (a, r) => `Replaced “${a.find}” → “${a.replace}” (${r.replaced}×)`,
    async run(a) {
      const find = str(a.find, "find");
      const replace = typeof a.replace === "string" ? a.replace : String(a.replace ?? "");
      return change(async () => {
        const { analyzePageText, applyTextEdit } = await import("../core/textedit/editor");
        const d = currentDoc();
        let bytes = d.bytes;
        let replaced = 0;
        let substituted = false;
        const pages: number[] = [];
        const lower = find.toLocaleLowerCase("tr");
        for (let p = 0; p < d.pageIds.length; p++) {
          const targets = (await analyzePageText(bytes, p)).filter((b) => b.editable && !b.invisible && b.text.toLocaleLowerCase("tr").includes(lower));
          for (const t of targets) {
            const cur = (await analyzePageText(bytes, p)).find((b) => b.text === t.text && Math.hypot(b.origin[0] - t.origin[0], b.origin[1] - t.origin[1]) < 1);
            if (!cur) continue;
            const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
            const next = cur.text.replace(re, () => {
              replaced++;
              return replace;
            });
            const r = await applyTextEdit(bytes, p, { blockId: cur.id, text: next });
            bytes = r.bytes;
            substituted ||= r.substituted;
            if (!pages.includes(p + 1)) pages.push(p + 1);
          }
        }
        if (!replaced) return { ok: false, error: `“${find}” was not found in editable text.` };
        await commit(label(`replace “${find}”`), { bytes });
        return { ok: true, replaced, pages, font_substituted: substituted || undefined };
      });
    },
  },
  {
    spec: spec(
      "add_text",
      "Write new text onto a page (as page content), e.g. a stamp, title or note.",
      {
        text: { type: "string", description: "Text; use \\n for new lines." },
        page: PAGE,
        position: { type: "string", enum: [...POSITIONS], description: "Default top-left." },
        size: { type: "number", description: "Font size in points (default 14)." },
        color: { type: "string", description: "Colour name or #rrggbb (default black)." },
        bold: { type: "boolean" },
      },
      ["text"],
    ),
    describe: (a, r) => `Wrote “${String(a.text).slice(0, 40)}” on page ${r.page}`,
    async run(a) {
      const text = str(a.text, "text").replace(/\\n/g, "\n");
      const p = pageIndex(a.page);
      const size = Math.min(144, Math.max(4, Number(a.size) || 14));
      return change(async () => {
        const g = (await geoms())[p];
        const lines = text.split("\n");
        const w = Math.max(...lines.map((l) => l.length)) * size * 0.52;
        const h = lines.length * size * 1.25;
        const [x, y] = placeAt(g, a.position, w, h);
        const { insertText } = await import("../core/textedit/editor");
        const r = await insertText(currentDoc().bytes, p, {
          origin: toUser(g, [x, y + size * 0.8]),
          dir: dirToUser(g, [1, 0]),
          up: dirToUser(g, [0, -1]),
          text,
          size,
          color: color(a.color, "#000000"),
          family: "sans",
          bold: !!a.bold,
        });
        await commit(label("add text"), { bytes: r.bytes });
        return { ok: true, page: p + 1 };
      });
    },
  },
  {
    spec: spec(
      "add_header_footer",
      "Put text in the header or footer (üst bilgi / alt bilgi, sayfa numarası) of pages. Use {page} for the page number, {pages} for the total, {date} for today.",
      {
        text: { type: "string", description: 'E.g. "Sayfa {page} / {pages}".' },
        position: { type: "string", enum: ["header-left", "header-center", "header-right", "footer-left", "footer-center", "footer-right"] },
        pages: { ...PAGES, description: PAGES.description + " Default: all." },
      },
      ["text", "position"],
    ),
    describe: (a, r) => `Added “${a.text}” to the ${String(a.position).replace("-", " ")} of ${r.pages} page${r.pages === 1 ? "" : "s"}`,
    async run(a) {
      const text = str(a.text, "text");
      const [where, side] = String(a.position || "footer-center").split("-") as ["header" | "footer", "left" | "center" | "right"];
      if (!["header", "footer"].includes(where) || !["left", "center", "right"].includes(side)) throw new Error("position must be like footer-center.");
      const pages = pageList(a.pages, "all");
      return change(async () => {
        const { stampPages } = await import("../core/stamp/stamp");
        const d = currentDoc();
        const bytes = await stampPages(d.bytes, { pages, fileName: d.name, fontSize: 9, [where]: { [side]: text } });
        await commit(label("header/footer"), { bytes });
        return { ok: true, pages: pages.length };
      });
    },
  },
  {
    spec: spec(
      "add_watermark",
      "Add a large diagonal watermark (filigran) text to pages, e.g. TASLAK, GİZLİ, DRAFT.",
      { text: { type: "string" }, opacity: { type: "number", description: "0.05–1 (default 0.2)." }, color: { type: "string", description: "Default red." }, pages: { ...PAGES, description: PAGES.description + " Default: all." } },
      ["text"],
    ),
    describe: (a) => `Added the watermark “${a.text}”`,
    async run(a) {
      const text = str(a.text, "text");
      const pages = pageList(a.pages, "all");
      return change(async () => {
        const { stampPages } = await import("../core/stamp/stamp");
        const d = currentDoc();
        const bytes = await stampPages(d.bytes, {
          pages,
          fileName: d.name,
          watermark: { text, size: 72, color: color(a.color, "#d1242f"), opacity: Math.min(1, Math.max(0.05, Number(a.opacity) || 0.2)), rotation: 45 },
        });
        await commit(label("watermark"), { bytes });
        return { ok: true, pages: pages.length };
      });
    },
  },
  {
    spec: spec("remove_headers_and_watermarks", "Remove the headers, footers, page numbers and watermarks added with Marmara PDF.", {}),
    describe: (_a, r) => (r.pages ? `Removed headers/watermarks from ${r.pages} pages` : "No headers or watermarks to remove"),
    async run() {
      return change(async () => {
        const { removeStamps } = await import("../core/stamp/stamp");
        const r = await removeStamps(currentDoc().bytes);
        if (!r.pages) return { ok: true, pages: 0 };
        await commit(label("remove headers & watermarks"), { bytes: r.bytes });
        return { ok: true, pages: r.pages };
      });
    },
  },
  {
    spec: spec("rotate_pages", "Rotate pages clockwise.", { pages: PAGES, angle: { type: "integer", enum: [90, 180, 270] } }, ["pages", "angle"]),
    describe: (a, r) => `Rotated ${r.count === 1 ? `page ${r.first}` : `${r.count} pages`} by ${a.angle}°`,
    async run(a) {
      const pages = pageList(a.pages, "current");
      const angle = Number(a.angle) || 90;
      if (angle % 90) throw new Error("angle must be 90, 180 or 270.");
      return change(async () => {
        const { rotatePages } = await import("../core/pdf/pageOps");
        await commit(label("rotate pages"), { bytes: await rotatePages(currentDoc().bytes, pages, angle) });
        return { ok: true, count: pages.length, first: pages[0] + 1 };
      });
    },
  },
  {
    spec: spec("delete_pages", "Delete pages from the document.", { pages: PAGES }, ["pages"]),
    describe: (_a, r) => `Deleted ${r.deleted} page${r.deleted === 1 ? "" : "s"}`,
    async run(a) {
      const pages = pageList(a.pages, "current");
      return change(async () => {
        const { doc, annotations } = useDoc.getState();
        if (!doc) throw new Error("No document is open.");
        if (pages.length >= doc.pageIds.length) return { ok: false, error: "A PDF must keep at least one page." };
        const { deletePages } = await import("../core/pdf/pageOps");
        const remove = new Set(pages);
        const next = { ...annotations };
        pages.forEach((i) => delete next[doc.pageIds[i]]);
        await commit(label("delete pages"), { bytes: await deletePages(doc.bytes, pages), pageIds: doc.pageIds.filter((_, i) => !remove.has(i)), annotations: next });
        useUi.setState({ currentPage: Math.min(useUi.getState().currentPage, doc.pageIds.length - pages.length - 1), selectedPages: [] });
        return { ok: true, deleted: pages.length, page_count: doc.pageIds.length - pages.length };
      });
    },
  },
  {
    spec: spec("move_pages", "Move pages to a new position.", { pages: PAGES, to: { type: "integer", description: "New position of the first moved page (1 = beginning)." } }, ["pages", "to"]),
    describe: (_a, r) => `Moved pages (new order ${String(r.order).slice(0, 40)})`,
    async run(a) {
      const pages = pageList(a.pages, "current");
      const n = pageCount();
      const to = Math.min(n + 1, Math.max(1, Number(a.to) || 1));
      return change(async () => {
        const { doc } = useDoc.getState();
        if (!doc) throw new Error("No document is open.");
        const { computeMoveOrder, reorderPages } = await import("../core/pdf/pageOps");
        // "to" is the final position; convert to an index in the original order.
        const rest = doc.pageIds.map((_, i) => i).filter((i) => !pages.includes(i));
        const target = to - 1 >= rest.length ? n : rest[to - 1];
        const order = computeMoveOrder(n, pages, target);
        await commit(label("move pages"), { bytes: await reorderPages(doc.bytes, order), pageIds: order.map((i) => doc.pageIds[i]) });
        return { ok: true, order: order.map((i) => i + 1).join(",") };
      });
    },
  },
  {
    spec: spec("insert_blank_page", "Insert an empty page.", { after: { type: "integer", description: "Insert after this page (0 = at the beginning; default: at the end)." } }),
    describe: (_a, r) => `Inserted a blank page as page ${r.page}`,
    async run(a) {
      const n = pageCount();
      const at = a.after === undefined || a.after === null ? n : Math.min(n, Math.max(0, Number(a.after)));
      return change(async () => {
        const { doc } = useDoc.getState();
        if (!doc) throw new Error("No document is open.");
        const { insertBlankPage } = await import("../core/pdf/pageOps");
        const pageIds = [...doc.pageIds];
        pageIds.splice(at, 0, newId());
        await commit(label("insert blank page"), { bytes: await insertBlankPage(doc.bytes, at), pageIds });
        return { ok: true, page: at + 1 };
      });
    },
  },
  {
    spec: spec(
      "mark_for_redaction",
      "Redact / black out / hide sensitive text (karart, karartma, sansürle, gizle, kişisel veriyi sil): marks every occurrence with redaction boxes. The user reviews them and applies them with Tools ▸ Apply redactions.",
      { query: { type: "string" } },
      ["query"],
    ),
    describe: (a, r) => `Marked ${r.marked} × “${a.query}” for redaction`,
    async run(a) {
      const query = str(a.query, "query");
      const { matches, total } = await search(query, pageList("all", "all"));
      if (!total) return { ok: false, error: `“${query}” does not occur in the document.` };
      const g = await geoms();
      const byPage = new Map<number, Annotation[]>();
      for (const m of matches) {
        const p = m.page - 1;
        byPage.set(p, [
          ...(byPage.get(p) ?? []),
          { id: newId(), type: "redact", rects: m.rects.map((r) => rectToUser(g[p], [r[0] - 0.5, r[1] - 0.5, r[2] + 0.5, r[3] + 0.5])), text: m.text, color: "#d1242f", opacity: 1, createdAt: Date.now() },
        ]);
      }
      await addAnnotations(byPage, `mark “${query}” for redaction`);
      return { ok: true, marked: matches.length, next_step: "Review the red boxes, then use Tools ▸ Apply redactions to remove the text permanently." };
    },
  },
  {
    spec: spec("list_form_fields", "List the fillable form fields with their current values and choices.", {}),
    describe: (_a, r) => `Looked at ${r.count} form fields`,
    async run() {
      const { readFields } = await import("../core/forms/read");
      const fields = await readFields(currentDoc().bytes);
      const values = useDoc.getState().formValues;
      return { ok: true, count: fields.length, fields: fields.slice(0, 60).map((f) => ({ name: f.name, type: f.type, value: values[f.name] ?? f.value, choices: f.options, page: f.pages[0] })) };
    },
  },
  {
    spec: spec(
      "fill_form",
      "Fill form fields. Checkboxes take true/false; dropdowns and radio buttons take one of their choices.",
      { values: { type: "object", description: 'Field name → value, e.g. {"Ad Soyad": "Ayşe Yılmaz", "Onay": true}.' } },
      ["values"],
    ),
    describe: (_a, r) => `Filled ${r.filled} form field${r.filled === 1 ? "" : "s"}`,
    async run(a) {
      const values = a.values;
      if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error('"values" must be an object of field names and values.');
      const { readFields } = await import("../core/forms/read");
      const fields = new Map((await readFields(currentDoc().bytes)).map((f) => [f.name, f]));
      const set: Record<string, string | boolean> = {};
      const unknown: string[] = [];
      for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
        const f = fields.get(k) ?? [...fields.values()].find((x) => x.name.toLocaleLowerCase("tr") === k.toLocaleLowerCase("tr"));
        if (!f) {
          unknown.push(k);
          continue;
        }
        set[f.name] = f.type === "checkbox" ? v === true || /^(true|yes|evet|on|1|x)$/i.test(String(v)) : String(v);
      }
      if (!Object.keys(set).length) return { ok: false, error: `No such fields: ${unknown.join(", ")}. Available: ${[...fields.keys()].slice(0, 30).join(", ")}` };
      await change(async () => {
        await commit(label("fill form"), { formValues: { ...useDoc.getState().formValues, ...set } });
      });
      return { ok: true, filled: Object.keys(set).length, unknown_fields: unknown.length ? unknown : undefined };
    },
  },
  {
    spec: spec("add_bookmark", "Add a bookmark (outline entry) pointing to a page.", { title: { type: "string" }, page: PAGE }, ["title"]),
    describe: (a, r) => `Added the bookmark “${a.title}” → page ${r.page}`,
    async run(a) {
      const title = str(a.title, "title");
      const p = pageIndex(a.page);
      return change(async () => {
        const { readOutline, writeOutline } = await import("../core/outline/outline");
        const bytes = currentDoc().bytes;
        const tree = await readOutline(bytes);
        tree.push({ id: newId(), title, page: p, open: true, children: [] });
        await commit(label("add bookmark"), { bytes: await writeOutline(bytes, tree) });
        return { ok: true, page: p + 1 };
      });
    },
  },
  {
    spec: spec("go_to_page", "Show a page to the user.", { page: { type: "integer" } }, ["page"]),
    describe: (_a, r) => `Went to page ${r.page}`,
    async run(a) {
      const p = pageIndex(a.page);
      viewer.scrollToPage(p);
      useUi.setState({ currentPage: p });
      return { ok: true, page: p + 1 };
    },
  },
  {
    spec: spec("compress_document", "Make the file smaller (re-compress images, remove duplicates).", {}),
    describe: (_a, r) => (r.ok ? `Compressed: ${r.saved}` : "Could not make the file smaller"),
    async run() {
      return change(async () => {
        const { compressPdf, COMPRESS_PRESETS } = await import("../core/optimize/compress");
        const r = await compressPdf(currentDoc().bytes, COMPRESS_PRESETS.ebook);
        if (r.after >= r.before) return { ok: false, error: "The file is already well optimised." };
        await commit(label("compress"), { bytes: r.bytes });
        const kb = (n: number) => `${Math.round(n / 1024)} KB`;
        return { ok: true, saved: `${kb(r.before)} → ${kb(r.after)} (−${Math.round((1 - r.after / r.before) * 100)}%)` };
      });
    },
  },
  {
    spec: spec("recognize_text", "Run OCR on scanned pages so their text becomes searchable and selectable (Turkish + English).", { pages: { ...PAGES, description: PAGES.description + " Default: pages without text." } }),
    describe: (_a, r) => (r.pages ? `Recognised text on ${r.pages} page${r.pages === 1 ? "" : "s"}` : "No pages needed OCR"),
    async run(a) {
      let pages: number[];
      if (a.pages) pages = pageList(a.pages, "all");
      else {
        const { pageTextOf } = await import("../core/search/mupdfText");
        pages = await withMupdf((m) => Array.from({ length: m.countPages() }, (_, i) => i).filter((i) => pageTextOf(m, i).replace(/\s/g, "").length < 12));
      }
      if (!pages.length) return { ok: true, pages: 0, note: "Every page already has text." };
      const { runOcr } = await import("../actions/ocrActions");
      await runOcr(pages, "tur+eng");
      return { ok: true, pages: pages.length };
    },
  },
  {
    spec: spec("export_to_word", "Convert the document to a Word file (.docx); the user chooses where to save it.", {}),
    describe: () => "Opened the Word export",
    async run() {
      const { exportToWord } = await import("../actions/convertActions");
      await exportToWord();
      return { ok: true, note: "The save dialog was shown to the user." };
    },
  },
];

export const TOOL_SPECS = TOOLS.map((t) => t.spec);
const byName = new Map(TOOLS.map((t) => [t.spec.function.name, t]));

export async function runTool(name: string, rawArgs: string): Promise<{ result: ToolResult; summary: string }> {
  const tool = byName.get(name);
  if (!tool) return { result: { ok: false, error: `Unknown tool ${name}.` }, summary: `Unknown tool ${name}` };
  let args: Args;
  try {
    args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return { result: { ok: false, error: "The tool arguments were not valid JSON." }, summary: `${name}: invalid arguments` };
  }
  try {
    const result = await tool.run(args);
    return { result, summary: result.ok ? tool.describe(args, result) : String(result.error ?? "Failed") };
  } catch (e) {
    const error = (e as Error)?.message || String(e);
    return { result: { ok: false, error }, summary: error };
  }
}
