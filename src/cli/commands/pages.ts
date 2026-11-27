import * as ops from "../../core/pdf/pageOps";
import { defineCommand, P, UsageError, WRITES, type Args, type Context } from "../registry";
import { fileInDir, guardSignatures, loadPdf, outputDir, outputPath, selectPages, stem, writeAtomic, writePdf, type PdfInput } from "../io";
import { PDFDocument } from "pdf-lib";

async function pageCount(bytes: Uint8Array) {
  return (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
}

async function open(a: Args, ctx: Context): Promise<PdfInput & { count: number }> {
  const input = await loadPdf(ctx, a.input as string, a.password as string);
  guardSignatures(input, a);
  return { ...input, count: await pageCount(input.bytes) };
}

const base = { input: P.input, ...WRITES, break_signatures: P.breakSignatures };

defineCommand({
  name: "merge",
  group: "Pages",
  summary: "Combine several PDFs into one, in the order given.",
  params: {
    inputs: { type: "path[]", description: "PDF files to combine (two or more).", required: true, positional: true },
    output: { ...P.output, description: "Result file. Default: <first>.merged.pdf next to the first input." },
    overwrite: P.overwrite,
    password: { type: "string", description: "Password for encrypted inputs (the result is not encrypted)." },
  },
  examples: ["merge a.pdf b.pdf c.pdf -o all.pdf"],
  async run(a, ctx) {
    const list = a.inputs as string[];
    if (list.length < 2) throw new UsageError("Give at least two PDF files to merge.");
    const inputs = [];
    for (const p of list) inputs.push(await loadPdf(ctx, p, a.password as string));
    const bytes = await ops.mergeDocuments(inputs.map((i) => i.bytes));
    const path = outputPath(ctx, { ...a, overwrite: a.output ? a.overwrite : false }, inputs[0].path, "merged", ".pdf");
    writeAtomic(path, bytes);
    return { output: path, page_count: await pageCount(bytes), inputs: inputs.map((i) => i.path) };
  },
});

defineCommand({
  name: "split",
  group: "Pages",
  summary: "Split a PDF into several files: every N pages, before given pages, or by explicit ranges.",
  params: {
    input: P.input,
    every: { type: "integer", description: "Start a new file every N pages." },
    at: { type: "string", description: 'Start a new file at these pages, e.g. "4,9" → 1-3, 4-8, 9-end.' },
    ranges: { type: "string[]", description: 'Explicit page ranges, one file each, e.g. "1-3" "4-10".' },
    output_dir: { type: "path", description: "Folder for the parts. Default: <name>-split next to the input." },
    overwrite: { type: "boolean", description: "Replace existing files in the output folder." },
    password: P.password,
  },
  examples: ["split book.pdf --every 10", "split book.pdf --at 5,12", 'split book.pdf --ranges 1-3 --ranges 4-'],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const n = await pageCount(input.bytes);
    const modes = [a.every, a.at, a.ranges].filter((x) => x !== undefined).length;
    if (modes !== 1) throw new UsageError("Give exactly one of --every, --at or --ranges.");
    let ranges: number[][];
    if (a.every !== undefined) {
      if ((a.every as number) < 1) throw new UsageError("--every must be at least 1.");
      ranges = ops.rangesEvery(n, a.every as number);
    } else if (a.at !== undefined) {
      const points = String(a.at).split(/[\s,]+/).filter(Boolean).map(Number);
      if (points.some((p) => !Number.isInteger(p) || p < 2 || p > n)) throw new UsageError(`Split points must be pages 2–${n}.`);
      ranges = ops.rangesAtSplitPoints(n, points);
    } else ranges = (a.ranges as string[]).map((r) => selectPages(r, n));
    const parts = await ops.splitDocument(input.bytes, ranges);
    const dir = outputDir(ctx, a, input.path, "split");
    const outputs = [];
    for (let k = 0; k < parts.length; k++) {
      const r = ranges[k];
      const label = r.length === 1 ? `p${r[0] + 1}` : `p${r[0] + 1}-${r[r.length - 1] + 1}`;
      const path = fileInDir(dir, `${stem(input.name)}-${label}.pdf`, !!a.overwrite);
      let bytes = parts[k];
      if (input.password) bytes = await (await import("../../core/mupdf/security")).encryptPdf(bytes, input.password);
      writeAtomic(path, bytes);
      outputs.push({ output: path, pages: `${r[0] + 1}${r.length > 1 ? `-${r[r.length - 1] + 1}` : ""}` });
    }
    return { output_dir: dir, files: outputs };
  },
});

defineCommand({
  name: "extract-pages",
  group: "Pages",
  summary: "Copy selected pages into a new PDF.",
  params: { input: P.input, pages: { ...P.pages, required: true }, ...WRITES },
  examples: ["extract-pages report.pdf --pages 2-4 -o summary.pdf"],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const sel = selectPages(a.pages, await pageCount(input.bytes));
    const out = await ops.extractPages(input.bytes, sel);
    return { output: await writePdf(ctx, a, input, out, "extract"), page_count: sel.length };
  },
});

defineCommand({
  name: "delete-pages",
  group: "Pages",
  summary: "Remove pages.",
  params: { ...base, pages: { ...P.pages, required: true } },
  examples: ["delete-pages report.pdf --pages 1,5-6"],
  async run(a, ctx) {
    const input = await open(a, ctx);
    const sel = selectPages(a.pages, input.count);
    if (sel.length >= input.count) throw new UsageError("Cannot delete every page.");
    const out = await ops.deletePages(input.bytes, sel);
    return { output: await writePdf(ctx, a, input, out, "deleted"), deleted: sel.length, page_count: input.count - sel.length };
  },
});

defineCommand({
  name: "rotate",
  group: "Pages",
  summary: "Rotate pages clockwise by 90, 180 or 270 degrees.",
  params: { ...base, pages: P.pages, angle: { type: "integer", description: "Clockwise degrees: 90, 180, 270 (or -90).", default: 90 } },
  examples: ["rotate scan.pdf --pages 2 --angle 180"],
  async run(a, ctx) {
    const angle = a.angle as number;
    if (angle % 90 !== 0) throw new UsageError("Angle must be a multiple of 90.");
    const input = await open(a, ctx);
    const sel = selectPages(a.pages, input.count);
    const out = await ops.rotatePages(input.bytes, sel, angle);
    return { output: await writePdf(ctx, a, input, out, "rotated"), rotated: sel.length };
  },
});

defineCommand({
  name: "move-pages",
  group: "Pages",
  summary: "Move pages so they start at a new position.",
  params: { ...base, pages: { ...P.pages, required: true }, to: { type: "integer", description: "Put the pages before this page number of the original order (page count + 1 = the end).", required: true } },
  examples: ["move-pages report.pdf --pages 7 --to 1"],
  async run(a, ctx) {
    const input = await open(a, ctx);
    const sel = selectPages(a.pages, input.count);
    const to = a.to as number;
    if (to < 1 || to > input.count + 1) throw new UsageError(`--to must be 1–${input.count + 1}.`);
    const order = ops.computeMoveOrder(input.count, sel, to - 1);
    const out = await ops.reorderPages(input.bytes, order);
    return { output: await writePdf(ctx, a, input, out, "reordered"), order: order.map((i) => i + 1) };
  },
});

defineCommand({
  name: "reorder",
  group: "Pages",
  summary: "Put the pages in a new order (a full permutation, 1-based).",
  params: { ...base, order: { type: "string", description: 'New order, e.g. "3,1,2,4" (every page exactly once).', required: true } },
  examples: ["reorder report.pdf --order 2,1,3"],
  async run(a, ctx) {
    const input = await open(a, ctx);
    const order = String(a.order).split(/[\s,]+/).filter(Boolean).map((x) => Number(x) - 1);
    const ok = order.length === input.count && new Set(order).size === input.count && order.every((i) => Number.isInteger(i) && i >= 0 && i < input.count);
    if (!ok) throw new UsageError(`--order must list every page 1–${input.count} exactly once.`);
    const out = await ops.reorderPages(input.bytes, order);
    return { output: await writePdf(ctx, a, input, out, "reordered") };
  },
});

defineCommand({
  name: "duplicate-pages",
  group: "Pages",
  summary: "Duplicate pages (each copy follows its original).",
  params: { ...base, pages: { ...P.pages, required: true } },
  async run(a, ctx) {
    const input = await open(a, ctx);
    const sel = selectPages(a.pages, input.count);
    const out = await ops.duplicatePages(input.bytes, sel);
    return { output: await writePdf(ctx, a, input, out, "duplicated"), page_count: input.count + sel.length };
  },
});

const SIZES: Record<string, [number, number]> = { a3: [841.89, 1190.55], a4: [595.28, 841.89], a5: [419.53, 595.28], letter: [612, 792], legal: [612, 1008] };

defineCommand({
  name: "insert-blank",
  group: "Pages",
  summary: "Insert a blank page.",
  params: {
    ...base,
    at: { type: "integer", description: "Position of the new page (1 = first; default: after the last page)." },
    size: { type: "string", description: 'Page size: a3, a4, a5, letter, legal or "WIDTHxHEIGHT" in points. Default: same as the neighbouring page.' },
    landscape: { type: "boolean", description: "Use the landscape orientation of --size." },
  },
  examples: ["insert-blank report.pdf --at 1 --size a4"],
  async run(a, ctx) {
    const input = await open(a, ctx);
    const at = (a.at as number | undefined) ?? input.count + 1;
    if (at < 1 || at > input.count + 1) throw new UsageError(`--at must be 1–${input.count + 1}.`);
    let size: [number, number] | undefined;
    if (a.size) {
      const s = String(a.size).toLowerCase();
      const m = /^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)$/.exec(s);
      size = SIZES[s] ? [...SIZES[s]] : m ? [+m[1], +m[2]] : undefined;
      if (!size) throw new UsageError(`Unknown size "${a.size}".`);
      if (a.landscape) size = [Math.max(...size), Math.min(...size)];
    }
    const out = await ops.insertBlankPage(input.bytes, at - 1, size);
    return { output: await writePdf(ctx, a, input, out, "inserted"), inserted_at: at, page_count: input.count + 1 };
  },
});

defineCommand({
  name: "insert-pages",
  group: "Pages",
  summary: "Insert pages from another PDF.",
  params: {
    ...base,
    from: { type: "path", description: "PDF to take pages from.", required: true },
    from_pages: { type: "string", description: "Pages of that file to insert (default: all)." },
    at: { type: "integer", description: "Position of the first inserted page (default: at the end)." },
  },
  examples: ["insert-pages report.pdf --from appendix.pdf --at 5"],
  async run(a, ctx) {
    const input = await open(a, ctx);
    const src = await loadPdf(ctx, a.from as string, a.password as string);
    const at = (a.at as number | undefined) ?? input.count + 1;
    if (at < 1 || at > input.count + 1) throw new UsageError(`--at must be 1–${input.count + 1}.`);
    const srcPages = a.from_pages ? selectPages(a.from_pages, await pageCount(src.bytes)) : undefined;
    const { bytes, inserted } = await ops.insertPagesFrom(input.bytes, at - 1, src.bytes, srcPages);
    return { output: await writePdf(ctx, a, input, bytes, "inserted"), inserted, page_count: input.count + inserted };
  },
});

