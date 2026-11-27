import { defineCommand, P, UsageError, WRITES } from "../registry";
import { dirToUser, guardSignatures, loadPdf, pageGeometries, pageIndex, readBytes, rectFromUser, rectToUser, selectPages, toUser, vecToUser, writePdf } from "../io";

const FAMILY = ["sans", "serif", "mono"] as const;

defineCommand({
  name: "text-blocks",
  group: "Edit text & objects",
  summary: "List the editable text blocks (paragraphs) of a page with ids, text, font and position — use the ids with edit-text.",
  readOnly: true,
  params: { input: P.input, page: P.page, include_invisible: { type: "boolean", description: "Include invisible text (e.g. an OCR layer)." }, password: P.password },
  examples: ["text-blocks letter.pdf --page 1"],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const geoms = await pageGeometries(input.bytes);
    const p = pageIndex(a.page, geoms.length);
    const { analyzePageText } = await import("../../core/textedit/editor");
    const blocks = (await analyzePageText(input.bytes, p)).filter((b) => a.include_invisible || !b.invisible);
    return {
      page: p + 1,
      blocks: blocks.map((b) => ({
        id: b.id,
        text: b.text,
        rect: rectFromUser(geoms[p], b.bbox),
        font: b.fontName,
        family: b.family,
        size: Math.round(b.size * 100) / 100,
        color: b.color,
        bold: b.bold,
        italic: b.italic,
        lines: b.lines,
        editable: b.editable,
        invisible: b.invisible || undefined,
      })),
    };
  },
});

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

defineCommand({
  name: "edit-text",
  group: "Edit text & objects",
  summary: "Edit existing text in the page content (not an overlay): replace a phrase everywhere, or rewrite/delete/restyle/move one block.",
  details:
    "Find mode: --find/--replace changes every block containing the phrase (paragraphs re-flow to their width). Block mode: --page and --block (from text-blocks) with --text (empty text deletes the block). The original font is kept when it has every glyph; otherwise a built-in font with full Unicode/Turkish support is used and reported as substituted.",
  params: {
    input: P.input,
    find: { type: "string", description: "Phrase to replace (find mode)." },
    replace: { type: "string", description: "Replacement text (find mode)." },
    match_case: { type: "boolean", description: "Case-sensitive find (default true).", default: true },
    first_only: { type: "boolean", description: "Only change the first occurrence." },
    pages: P.pages,
    page: { type: "integer", description: "Page of the block (block mode)." },
    block: { type: "string", description: "Block id from text-blocks (block mode)." },
    text: { type: "string", description: "New text of the block; empty deletes it (block mode)." },
    size: { type: "number", description: "New font size in points." },
    color: P.color,
    family: { type: "string", enum: FAMILY, description: "Re-typeset in a built-in family: sans, serif or mono." },
    move: { type: "point", description: 'Move the block by "dx,dy" points (display coordinates, y down; block mode).' },
    ...WRITES,
    break_signatures: P.breakSignatures,
  },
  examples: ['edit-text contract.pdf --find "2025" --replace "2026"', 'edit-text letter.pdf --page 1 --block p0-b3 --text "Yeni paragraf metni"'],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    guardSignatures(input, a);
    const { analyzePageText, applyTextEdit } = await import("../../core/textedit/editor");
    const geoms = await pageGeometries(input.bytes);
    let bytes = input.bytes;
    const style = { size: a.size as number | undefined, color: a.color as string | undefined, family: a.family as (typeof FAMILY)[number] | undefined };
    const edits: Record<string, unknown>[] = [];
    const record = (page: number, before: string, after: string, r: { mode: string; font: string; substituted: boolean }) =>
      edits.push({ page: page + 1, before, after, mode: r.mode, font: r.font, font_substituted: r.substituted || undefined });

    if (a.find !== undefined) {
      if (a.block || a.text !== undefined) throw new UsageError("Use either --find/--replace or --block/--text, not both.");
      if (a.replace === undefined) throw new UsageError("--find needs --replace.");
      const find = a.find as string;
      if (!find) throw new UsageError("--find must not be empty.");
      const re = new RegExp(escapeRe(find), a.match_case ? "gu" : "giu");
      const pages = a.page ? [pageIndex(a.page, geoms.length)] : selectPages(a.pages, geoms.length);
      outer: for (const p of pages) {
        const targets = (await analyzePageText(bytes, p)).filter((b) => b.editable && !b.invisible && new RegExp(re.source, re.flags.replace("g", "")).test(b.text));
        for (const t of targets) {
          const cur = (await analyzePageText(bytes, p)).find((b) => b.text === t.text && Math.hypot(b.origin[0] - t.origin[0], b.origin[1] - t.origin[1]) < 1);
          if (!cur) continue;
          const after = a.first_only ? cur.text.replace(new RegExp(re.source, re.flags.replace("g", "")), () => a.replace as string) : cur.text.replace(re, () => a.replace as string);
          const r = await applyTextEdit(bytes, p, { blockId: cur.id, text: after, ...style });
          bytes = r.bytes;
          record(p, cur.text, after, r);
          if (a.first_only) break outer;
        }
      }
      if (!edits.length) return { output: null, edits, message: `"${find}" was not found in editable text.` };
    } else {
      if (!a.page || !a.block) throw new UsageError("Give --find/--replace, or --page with --block (ids come from text-blocks).");
      const p = pageIndex(a.page, geoms.length);
      const blocks = await analyzePageText(bytes, p);
      const b = blocks.find((x) => x.id === a.block);
      if (!b) throw new UsageError(`Block "${a.block}" not found on page ${p + 1}. Run text-blocks again: ids change after edits.`);
      if (!b.editable) throw new UsageError(`Block "${a.block}" cannot be edited (unsupported font encoding).`);
      const d = a.move ? vecToUser(geoms[p], a.move as number[]) : undefined;
      const text = (a.text as string | undefined) ?? b.text;
      const r = await applyTextEdit(bytes, p, { blockId: b.id, text, ...style, dx: d?.[0], dy: d?.[1] });
      bytes = r.bytes;
      record(p, b.text, text, r);
    }
    return { output: await writePdf(ctx, a, input, bytes, "edited"), edits };
  },
});

defineCommand({
  name: "add-text",
  group: "Edit text & objects",
  summary: "Add new text to a page as real page content (Unicode/Turkish supported, optional wrapping).",
  params: {
    input: P.input,
    page: P.page,
    at: { type: "point", description: 'Top-left corner of the first line, "x,y" in points from the top-left of the page.', required: true },
    text: { type: "string", description: "Text; \\n starts a new line.", required: true },
    size: { type: "number", description: "Font size in points (default 12).", default: 12 },
    color: { ...P.color, default: "#000000" },
    family: { type: "string", enum: FAMILY, description: "Font family (default sans).", default: "sans" },
    bold: { type: "boolean", description: "Bold." },
    italic: { type: "boolean", description: "Italic." },
    width: { type: "number", description: "Wrap lines to this width in points." },
    ...WRITES,
    break_signatures: P.breakSignatures,
  },
  examples: ['add-text form.pdf --page 1 --at 72,100 --text "Onaylandı" --size 14 --color #d1242f --bold'],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    guardSignatures(input, a);
    const geoms = await pageGeometries(input.bytes);
    const p = pageIndex(a.page, geoms.length);
    const g = geoms[p];
    const at = a.at as number[];
    const size = a.size as number;
    const { insertText } = await import("../../core/textedit/editor");
    const r = await insertText(input.bytes, p, {
      origin: toUser(g, [at[0], at[1] + size * 0.8]),
      dir: dirToUser(g, [1, 0]),
      up: dirToUser(g, [0, -1]),
      text: (a.text as string).replace(/\\n/g, "\n"),
      size,
      color: a.color as string,
      family: a.family as (typeof FAMILY)[number],
      bold: !!a.bold,
      italic: !!a.italic,
      width: a.width as number | undefined,
    });
    return { output: await writePdf(ctx, a, input, r.bytes, "edited"), font: r.font };
  },
});

defineCommand({
  name: "objects",
  group: "Edit text & objects",
  summary: "List the images and vector graphics drawn on a page, with ids for edit-object.",
  readOnly: true,
  params: { input: P.input, page: P.page, password: P.password },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const geoms = await pageGeometries(input.bytes);
    const p = pageIndex(a.page, geoms.length);
    const { listPageObjects } = await import("../../core/objects/objects");
    const list = await listPageObjects(input.bytes, p);
    return {
      page: p + 1,
      objects: list.map((o) => ({ id: o.id, kind: o.kind, rect: rectFromUser(geoms[p], o.bbox), fill: o.fill || undefined, stroke: o.stroke || undefined })),
    };
  },
});

defineCommand({
  name: "edit-object",
  group: "Edit text & objects",
  summary: "Delete, move, resize, recolour or replace an image / vector graphic already on the page.",
  params: {
    input: P.input,
    page: P.page,
    id: { type: "string", description: "Object id from the objects command.", required: true },
    action: { type: "string", enum: ["delete", "move", "resize", "recolor", "replace-image"], description: "What to do.", required: true },
    rect: { type: "rect", description: "New position and size (move/resize), display coordinates." },
    by: { type: "point", description: 'Move by "dx,dy" points (move).' },
    fill: { type: "string", description: "New fill colour #rrggbb (recolor)." },
    stroke: { type: "string", description: "New stroke colour #rrggbb (recolor)." },
    image: { type: "path", description: "PNG/JPEG that replaces the image (replace-image)." },
    ...WRITES,
    break_signatures: P.breakSignatures,
  },
  examples: ["edit-object flyer.pdf --page 1 --id img-0 --action move --by 0,50", "edit-object flyer.pdf --page 1 --id path-3 --action recolor --fill #2da44e"],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    guardSignatures(input, a);
    const geoms = await pageGeometries(input.bytes);
    const p = pageIndex(a.page, geoms.length);
    const g = geoms[p];
    const { listPageObjects, editPageObject } = await import("../../core/objects/objects");
    const obj = (await listPageObjects(input.bytes, p)).find((o) => o.id === a.id);
    if (!obj) throw new UsageError(`Object "${a.id}" not found on page ${p + 1}. Run objects again: ids change after edits.`);
    let edit: Parameters<typeof editPageObject>[3];
    switch (a.action) {
      case "delete":
        edit = { action: "delete" };
        break;
      case "move":
      case "resize": {
        let target = a.rect as number[] | undefined;
        if (!target && a.by) {
          const cur = rectFromUser(g, obj.bbox);
          const [dx, dy] = a.by as number[];
          target = [cur[0] + dx, cur[1] + dy, cur[2] + dx, cur[3] + dy];
        }
        if (!target) throw new UsageError(`--action ${a.action} needs --rect${a.action === "move" ? " or --by" : ""}.`);
        edit = { action: "transform", to: rectToUser(g, target) };
        break;
      }
      case "recolor":
        if (!a.fill && !a.stroke) throw new UsageError("--action recolor needs --fill and/or --stroke.");
        edit = { action: "recolor", fill: a.fill as string | undefined, stroke: a.stroke as string | undefined };
        break;
      default:
        if (!a.image) throw new UsageError("--action replace-image needs --image.");
        edit = { action: "replace-image", image: readBytes(ctx, a.image as string) };
    }
    const out = await editPageObject(input.bytes, p, obj.id, edit);
    return { output: await writePdf(ctx, a, input, out, "edited"), object: obj.id, action: a.action };
  },
});
