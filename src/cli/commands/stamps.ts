import type { OutlineNode } from "../../core/outline/outline";
import type { StampOptions } from "../../core/stamp/stamp";
import { newId } from "../../core/ids";
import { defineCommand, P, UsageError, WRITES, type Args } from "../registry";
import { guardSignatures, loadPdf, pageGeometries, selectPages, writePdf } from "../io";

const TOKENS = "Tokens: {page} {pages} {date} {file} {bates}.";
const common = {
  pages: P.pages,
  font_size: { type: "number", description: "Font size in points (default 9)." },
  color: { type: "string", description: "Text colour #rrggbb (default #000000)." },
  family: { type: "string", enum: ["sans", "serif", "mono"], description: "Font family (default sans)." },
  margin: { type: "number", description: "Distance from the page edge in points (default 28)." },
  start_number: { type: "integer", description: "Number of the first stamped page for {page} (default 1)." },
} as const;

async function stamp(a: Args, ctx: Parameters<Parameters<typeof defineCommand>[0]["run"]>[1], o: Omit<StampOptions, "pages">, suffix: string) {
  const input = await loadPdf(ctx, a.input as string, a.password as string);
  guardSignatures(input, a);
  const geoms = await pageGeometries(input.bytes);
  const pages = selectPages(a.pages, geoms.length);
  const { stampPages } = await import("../../core/stamp/stamp");
  const out = await stampPages(input.bytes, {
    pages,
    fontSize: a.font_size as number | undefined,
    color: a.color as string | undefined,
    family: a.family as StampOptions["family"],
    margin: a.margin as number | undefined,
    startNumber: a.start_number as number | undefined,
    fileName: input.name,
    ...o,
  });
  return { output: await writePdf(ctx, a, input, out, suffix), pages: pages.length };
}

defineCommand({
  name: "header-footer",
  group: "Headers, watermarks & bookmarks",
  summary: `Add headers/footers and page numbers (left/centre/right). ${TOKENS} Re-applying replaces earlier headers/footers only.`,
  params: {
    input: P.input,
    header_left: { type: "string", description: "Header text, left." },
    header_center: { type: "string", description: "Header text, centre." },
    header_right: { type: "string", description: "Header text, right." },
    footer_left: { type: "string", description: "Footer text, left." },
    footer_center: { type: "string", description: 'Footer text, centre, e.g. "Sayfa {page} / {pages}".' },
    footer_right: { type: "string", description: "Footer text, right." },
    ...common,
    ...WRITES,
    break_signatures: P.breakSignatures,
  },
  examples: ['header-footer report.pdf --footer-center "Sayfa {page} / {pages}" --header-right "{date}"'],
  async run(a, ctx) {
    const header = { left: a.header_left as string, center: a.header_center as string, right: a.header_right as string };
    const footer = { left: a.footer_left as string, center: a.footer_center as string, right: a.footer_right as string };
    const any = (x: Record<string, string>) => Object.values(x).some((v) => v);
    if (!any(header) && !any(footer)) throw new UsageError("Give at least one header or footer text, e.g. --footer-center \"{page} / {pages}\".");
    return stamp(a, ctx, { header: any(header) ? header : undefined, footer: any(footer) ? footer : undefined }, "stamped");
  },
});

defineCommand({
  name: "watermark",
  group: "Headers, watermarks & bookmarks",
  summary: "Add a text watermark across the pages (re-applying replaces the previous watermark only).",
  params: {
    input: P.input,
    text: { type: "string", description: "Watermark text.", required: true, positional: false },
    size: { type: "number", description: "Font size (default 72).", default: 72 },
    color: { type: "string", description: "Colour #rrggbb (default #d1242f).", default: "#d1242f" },
    opacity: { type: "number", description: "0.05–1 (default 0.2).", default: 0.2 },
    rotation: { type: "number", description: "Degrees counter-clockwise (default 45).", default: 45 },
    pages: P.pages,
    ...WRITES,
    break_signatures: P.breakSignatures,
  },
  examples: ['watermark draft.pdf --text TASLAK', 'watermark draft.pdf --text "GİZLİ" --opacity 0.3 --rotation 30'],
  async run(a, ctx) {
    const opacity = Math.min(1, Math.max(0.05, a.opacity as number));
    return stamp(a, ctx, { watermark: { text: a.text as string, size: a.size as number, color: a.color as string, opacity, rotation: a.rotation as number } }, "watermarked");
  },
});

defineCommand({
  name: "bates",
  group: "Headers, watermarks & bookmarks",
  summary: "Add Bates numbers (prefix + zero-padded counter) to each page; coexists with page numbers.",
  params: {
    input: P.input,
    prefix: { type: "string", description: "Prefix, e.g. ABC-.", default: "" },
    start: { type: "integer", description: "First number (default 1).", default: 1 },
    digits: { type: "integer", description: "Zero-padded width (default 6).", default: 6 },
    suffix: { type: "string", description: "Suffix." },
    position: { type: "string", enum: ["footer-right", "footer-center", "footer-left", "header-right", "header-center", "header-left"], description: "Where (default footer-right).", default: "footer-right" },
    ...common,
    ...WRITES,
    break_signatures: P.breakSignatures,
  },
  examples: ["bates evidence.pdf --prefix DAVA- --start 101 --digits 5"],
  async run(a, ctx) {
    const [where, side] = String(a.position).split("-") as ["header" | "footer", "left" | "center" | "right"];
    const res = await stamp(a, ctx, { bates: { prefix: a.prefix as string, start: a.start as number, digits: a.digits as number, suffix: a.suffix as string | undefined }, [where]: { [side]: "{bates}" } }, "bates");
    const first = `${a.prefix}${String(a.start).padStart(a.digits as number, "0")}${a.suffix ?? ""}`;
    const last = `${a.prefix}${String((a.start as number) + res.pages - 1).padStart(a.digits as number, "0")}${a.suffix ?? ""}`;
    return { ...res, first, last };
  },
});

defineCommand({
  name: "remove-stamps",
  group: "Headers, watermarks & bookmarks",
  summary: "Remove all headers, footers, page/Bates numbers and watermarks added by Marmara PDF.",
  params: { input: P.input, ...WRITES, break_signatures: P.breakSignatures },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    guardSignatures(input, a);
    const { removeStamps } = await import("../../core/stamp/stamp");
    const r = await removeStamps(input.bytes);
    if (!r.pages) return { output: null, pages: 0, message: "No stamps added by Marmara PDF were found." };
    return { output: await writePdf(ctx, a, input, r.bytes, "unstamped"), pages: r.pages };
  },
});

// ---------- bookmarks ----------

interface BookmarkJson {
  title: string;
  page: number | null;
  open?: boolean;
  children?: BookmarkJson[];
}

const toJson = (nodes: OutlineNode[]): BookmarkJson[] =>
  nodes.map((n) => ({ title: n.title, page: n.page >= 0 ? n.page + 1 : null, ...(n.children.length ? { open: n.open, children: toJson(n.children) } : {}) }));

function fromJson(list: unknown, pageCount: number, path = "bookmarks"): OutlineNode[] {
  if (!Array.isArray(list)) throw new UsageError(`${path} must be an array of {title, page, children?}.`);
  return list.map((x, i) => {
    const o = x as BookmarkJson;
    if (!o || typeof o.title !== "string" || !o.title.trim()) throw new UsageError(`${path}[${i}].title must be a non-empty string.`);
    const page = o.page == null ? -1 : Number(o.page) - 1;
    if (page !== -1 && (!Number.isInteger(page) || page < 0 || page >= pageCount)) throw new UsageError(`${path}[${i}].page must be 1–${pageCount} or null.`);
    return { id: newId(), title: o.title.trim(), page, open: o.open ?? true, children: o.children ? fromJson(o.children, pageCount, `${path}[${i}].children`) : [] };
  });
}

defineCommand({
  name: "bookmarks",
  group: "Headers, watermarks & bookmarks",
  summary: "List the bookmarks (outline) as a tree with 1-based target pages.",
  readOnly: true,
  params: { input: P.input, password: P.password },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const { readOutline } = await import("../../core/outline/outline");
    const tree = toJson(await readOutline(input.bytes));
    return { bookmarks: tree };
  },
});

defineCommand({
  name: "set-bookmarks",
  group: "Headers, watermarks & bookmarks",
  summary: "Replace the whole bookmark tree (JSON: [{title, page, children?}]). An empty array removes all bookmarks.",
  params: {
    input: P.input,
    bookmarks: { type: "json", schema: { type: "array", items: { type: "object", properties: { title: { type: "string" }, page: { type: ["integer", "null"] }, children: { type: "array", items: { type: "object" } } }, required: ["title"] } }, description: 'Tree, e.g. [{"title":"Giriş","page":1},{"title":"Bölüm 1","page":3,"children":[{"title":"1.1","page":4}]}].', required: true },
    ...WRITES,
    break_signatures: P.breakSignatures,
  },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    guardSignatures(input, a);
    const geoms = await pageGeometries(input.bytes);
    const nodes = fromJson(a.bookmarks, geoms.length);
    const { writeOutline } = await import("../../core/outline/outline");
    const out = await writeOutline(input.bytes, nodes);
    return { output: await writePdf(ctx, a, input, out, "bookmarked"), bookmarks: toJson(nodes) };
  },
});

defineCommand({
  name: "add-bookmark",
  group: "Headers, watermarks & bookmarks",
  summary: "Add one bookmark at the end of the outline, or as the last child of an existing bookmark.",
  params: {
    input: P.input,
    title: { type: "string", description: "Bookmark title.", required: true },
    page: P.page,
    parent: { type: "string", description: "Title of the bookmark to nest under (first match)." },
    ...WRITES,
    break_signatures: P.breakSignatures,
  },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    guardSignatures(input, a);
    const geoms = await pageGeometries(input.bytes);
    const { readOutline, writeOutline } = await import("../../core/outline/outline");
    const tree = await readOutline(input.bytes);
    const node: OutlineNode = { id: newId(), title: String(a.title).trim(), page: fromJson([{ title: "x", page: a.page as number }], geoms.length)[0].page, open: true, children: [] };
    if (a.parent) {
      const find = (l: OutlineNode[]): OutlineNode | null => {
        for (const n of l) {
          if (n.title === a.parent) return n;
          const c = find(n.children);
          if (c) return c;
        }
        return null;
      };
      const parent = find(tree);
      if (!parent) throw new UsageError(`No bookmark titled "${a.parent}".`);
      parent.children.push(node);
      parent.open = true;
    } else tree.push(node);
    const out = await writeOutline(input.bytes, tree);
    return { output: await writePdf(ctx, a, input, out, "bookmarked"), bookmarks: toJson(tree) };
  },
});
