import { degrees, PDFDocument, type PDFPage } from "pdf-lib";

/**
 * Page-level document operations, implemented with pdf-lib.
 *
 * Every function is pure: it takes PDF bytes and returns new PDF bytes. Pages
 * are moved/removed *within the same document* where possible so that page
 * content, resources and document-level data (metadata, outlines, forms) are
 * preserved instead of being copied into a fresh document.
 */

export class EncryptedPdfError extends Error {
  constructor() {
    super("This PDF is encrypted. Page editing requires an unencrypted document.");
    this.name = "EncryptedPdfError";
  }
}

export async function loadEditable(bytes: Uint8Array): Promise<PDFDocument> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) throw new EncryptedPdfError();
  return doc;
}

export async function saveDoc(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({ updateFieldAppearances: false });
}

function normRotation(angle: number): number {
  return ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
}

/** Visible size of a page in PDF points (rotation applied). */
export function displayedSize(page: PDFPage): [number, number] {
  const { width, height } = page.getSize();
  const rot = normRotation(page.getRotation().angle);
  return rot === 90 || rot === 270 ? [height, width] : [width, height];
}

/** Reorders pages in place. `order[i]` is the old index of the page that ends up at position i. */
function applyOrder(doc: PDFDocument, order: number[]) {
  const pages = doc.getPages();
  if (order.length !== pages.length) throw new Error("order length mismatch");
  for (let i = pages.length - 1; i >= 0; i--) doc.removePage(i);
  order.forEach((oldIndex, i) => doc.insertPage(i, pages[oldIndex]));
}

export async function rotatePages(bytes: Uint8Array, indices: number[], delta: number): Promise<Uint8Array> {
  const doc = await loadEditable(bytes);
  const pages = doc.getPages();
  for (const i of indices) {
    const p = pages[i];
    p.setRotation(degrees(normRotation(p.getRotation().angle + delta)));
  }
  return saveDoc(doc);
}

export async function deletePages(bytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  const doc = await loadEditable(bytes);
  if (new Set(indices).size >= doc.getPageCount()) throw new Error("A PDF must keep at least one page.");
  [...new Set(indices)].sort((a, b) => b - a).forEach((i) => doc.removePage(i));
  return saveDoc(doc);
}

/** Moves the given pages so they start at `target` (an index in the *original* order, 0..n). */
export function computeMoveOrder(count: number, indices: number[], target: number): number[] {
  const moving = [...new Set(indices)].sort((a, b) => a - b);
  const movingSet = new Set(moving);
  const rest: number[] = [];
  let insertAt = 0;
  for (let i = 0; i < count; i++) {
    if (i === target) insertAt = rest.length;
    if (!movingSet.has(i)) rest.push(i);
  }
  if (target >= count) insertAt = rest.length;
  return [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
}

export async function reorderPages(bytes: Uint8Array, order: number[]): Promise<Uint8Array> {
  const doc = await loadEditable(bytes);
  applyOrder(doc, order);
  return saveDoc(doc);
}

/** Duplicates each page and places the copy right after the original. */
export async function duplicatePages(bytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  const doc = await loadEditable(bytes);
  const sorted = [...new Set(indices)].sort((a, b) => b - a);
  const copies = await doc.copyPages(doc, sorted);
  sorted.forEach((i, k) => doc.insertPage(i + 1, copies[k]));
  return saveDoc(doc);
}

/** Inserts a blank page at `at`. Size defaults to the neighbouring page's visible size. */
export async function insertBlankPage(bytes: Uint8Array, at: number, size?: [number, number]): Promise<Uint8Array> {
  const doc = await loadEditable(bytes);
  const pages = doc.getPages();
  const ref = pages[Math.min(Math.max(at - 1, 0), pages.length - 1)];
  doc.insertPage(at, size ?? (ref ? displayedSize(ref) : [595.28, 841.89]));
  return saveDoc(doc);
}

/** Inserts all (or some) pages of another PDF at `at`. */
export async function insertPagesFrom(
  bytes: Uint8Array,
  at: number,
  sourceBytes: Uint8Array,
  sourceIndices?: number[],
): Promise<{ bytes: Uint8Array; inserted: number }> {
  const doc = await loadEditable(bytes);
  const src = await loadEditable(sourceBytes);
  const indices = sourceIndices ?? src.getPageIndices();
  const copies = await doc.copyPages(src, indices);
  copies.forEach((p, k) => doc.insertPage(at + k, p));
  return { bytes: await saveDoc(doc), inserted: copies.length };
}

/** Creates a new PDF containing only the given pages (in the given order). */
export async function extractPages(bytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  const src = await loadEditable(bytes);
  const out = await PDFDocument.create();
  const copies = await out.copyPages(src, indices);
  copies.forEach((p) => out.addPage(p));
  const title = src.getTitle();
  if (title) out.setTitle(title);
  out.setProducer("Marmara PDF");
  return saveDoc(out);
}

/** Merges whole documents, in order, into a new PDF. */
export async function mergeDocuments(inputs: Uint8Array[]): Promise<Uint8Array> {
  if (inputs.length === 0) throw new Error("Nothing to merge.");
  const out = await loadEditable(inputs[0]);
  for (const bytes of inputs.slice(1)) {
    const src = await loadEditable(bytes);
    const copies = await out.copyPages(src, src.getPageIndices());
    copies.forEach((p) => out.addPage(p));
  }
  return saveDoc(out);
}

/** Splits a document into consecutive ranges, e.g. [[0,1,2],[3,4]]. */
export async function splitDocument(bytes: Uint8Array, ranges: number[][]): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const r of ranges) if (r.length) out.push(await extractPages(bytes, r));
  return out;
}

/**
 * Parses a page-range expression like "1-3, 5, 8-" (1-based, inclusive) into
 * 0-based indices. Throws on invalid input.
 */
export function parsePageRanges(expr: string, pageCount: number): number[] {
  const result: number[] = [];
  for (const part of expr.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d*)\s*(-)?\s*(\d*)$/.exec(part);
    if (!m || (!m[1] && !m[3])) throw new Error(`Invalid page range "${part}"`);
    const a = m[1] ? parseInt(m[1], 10) : 1;
    const b = m[2] ? (m[3] ? parseInt(m[3], 10) : pageCount) : a;
    if (a < 1 || b > pageCount || a > b) throw new Error(`Page range "${part}" is outside 1–${pageCount}`);
    for (let p = a; p <= b; p++) result.push(p - 1);
  }
  if (!result.length) throw new Error("No pages selected");
  return result;
}

/** Builds split ranges: every `n` pages. */
export function rangesEvery(pageCount: number, n: number): number[][] {
  const ranges: number[][] = [];
  for (let s = 0; s < pageCount; s += n) ranges.push(Array.from({ length: Math.min(n, pageCount - s) }, (_, k) => s + k));
  return ranges;
}

/** Builds split ranges from 1-based split points, e.g. "4, 9" → [1-3],[4-8],[9-end]. */
export function rangesAtSplitPoints(pageCount: number, points: number[]): number[][] {
  const starts = [0, ...[...new Set(points)].map((p) => p - 1).filter((p) => p > 0 && p < pageCount).sort((a, b) => a - b)];
  return starts.map((s, k) => {
    const e = k + 1 < starts.length ? starts[k + 1] : pageCount;
    return Array.from({ length: e - s }, (_, j) => s + j);
  });
}
