import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  computeMoveOrder,
  deletePages,
  duplicatePages,
  extractPages,
  insertBlankPage,
  insertPagesFrom,
  mergeDocuments,
  parsePageRanges,
  rangesAtSplitPoints,
  rangesEvery,
  reorderPages,
  rotatePages,
  splitDocument,
} from "./pageOps";

/** Creates a PDF whose page i has width 100+i so pages are identifiable. */
async function makePdf(n: number, label = "P"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const p = doc.addPage([100 + i, 200]);
    p.drawText(`${label}${i + 1}`, { x: 10, y: 100, size: 12, font });
  }
  return doc.save();
}

async function widths(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => Math.round(p.getWidth()));
}

describe("pageOps", () => {
  it("rotates selected pages and normalises angles", async () => {
    let b = await rotatePages(await makePdf(3), [0, 2], 90);
    b = await rotatePages(b, [0], -180);
    const doc = await PDFDocument.load(b);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([270, 0, 90]);
  });

  it("deletes pages and refuses to delete all", async () => {
    const b = await deletePages(await makePdf(4), [1, 3]);
    expect(await widths(b)).toEqual([100, 102]);
    await expect(deletePages(b, [0, 1])).rejects.toThrow();
  });

  it("computes move orders", () => {
    expect(computeMoveOrder(5, [0], 3)).toEqual([1, 2, 0, 3, 4]);
    expect(computeMoveOrder(5, [4], 0)).toEqual([4, 0, 1, 2, 3]);
    expect(computeMoveOrder(5, [1, 2], 5)).toEqual([0, 3, 4, 1, 2]);
    expect(computeMoveOrder(5, [1, 3], 2)).toEqual([0, 1, 3, 2, 4]);
  });

  it("reorders pages in place", async () => {
    const b = await reorderPages(await makePdf(4), [3, 0, 2, 1]);
    expect(await widths(b)).toEqual([103, 100, 102, 101]);
  });

  it("duplicates pages next to originals", async () => {
    const b = await duplicatePages(await makePdf(3), [0, 2]);
    expect(await widths(b)).toEqual([100, 100, 101, 102, 102]);
  });

  it("inserts blank pages using the neighbour size", async () => {
    const b = await insertBlankPage(await makePdf(2), 1);
    expect(await widths(b)).toEqual([100, 100, 101]);
  });

  it("inserts pages from another document", async () => {
    const { bytes, inserted } = await insertPagesFrom(await makePdf(2), 1, await makePdf(3, "Q"), [2, 0]);
    expect(inserted).toBe(2);
    expect(await widths(bytes)).toEqual([100, 102, 100, 101]);
  });

  it("extracts, merges and splits", async () => {
    const src = await makePdf(5);
    expect(await widths(await extractPages(src, [4, 1]))).toEqual([104, 101]);
    expect(await widths(await mergeDocuments([await makePdf(2), await makePdf(1)]))).toEqual([100, 101, 100]);
    const parts = await splitDocument(src, rangesEvery(5, 2));
    expect(await Promise.all(parts.map(widths))).toEqual([[100, 101], [102, 103], [104]]);
  });

  it("parses page ranges", () => {
    expect(parsePageRanges("1-3, 5, 7-", 8)).toEqual([0, 1, 2, 4, 6, 7]);
    expect(() => parsePageRanges("0-2", 5)).toThrow();
    expect(() => parsePageRanges("abc", 5)).toThrow();
    expect(rangesAtSplitPoints(10, [4, 9])).toEqual([[0, 1, 2], [3, 4, 5, 6, 7], [8, 9]]);
  });
});
