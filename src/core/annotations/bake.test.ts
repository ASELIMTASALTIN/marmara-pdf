import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import * as mupdf from "mupdf";
import { bakeAnnotations, importAnnotations } from "./bake";
import type { Annotation, AnnotationMap } from "./types";

// 1×1 red PNG
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

async function blankPdf(n: number) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([600, 800]);
  return doc.save();
}

const base = { color: "#ff0000", opacity: 1, createdAt: Date.now() };
const all: Annotation[] = [
  { ...base, id: "h", type: "highlight", rects: [[50, 700, 200, 715]], text: "hello", opacity: 0.5 },
  { ...base, id: "u", type: "underline", rects: [[50, 680, 200, 695]], text: "x" },
  { ...base, id: "s", type: "strikeout", rects: [[50, 660, 200, 675]], text: "y" },
  { ...base, id: "i", type: "ink", width: 2, paths: [[[10, 10], [50, 60], [90, 20]]] },
  { ...base, id: "r", type: "rect", rect: [100, 100, 200, 160], width: 2, fill: "#00ff00" },
  { ...base, id: "e", type: "ellipse", rect: [220, 100, 300, 160], width: 1.5 },
  { ...base, id: "l", type: "line", from: [10, 300], to: [200, 320], width: 2 },
  { ...base, id: "a", type: "arrow", from: [10, 350], to: [200, 370], width: 2 },
  { ...base, id: "f", type: "freetext", rect: [300, 500, 500, 540], text: "Şirket ğüı", fontSize: 14 },
  { ...base, id: "n", type: "note", point: [550, 780], text: "Not: kontrol et" },
  { ...base, id: "g", type: "signature", rect: [350, 50, 500, 100], dataUrl: PNG },
];

describe("annotation bake / import", () => {
  it("writes every annotation type as a real PDF annotation", async () => {
    const map: AnnotationMap = { p1: all, p2: [] };
    const out = await bakeAnnotations(await blankPdf(2), ["p1", "p2"], map);
    const doc = mupdf.Document.openDocument(out, "application/pdf").asPDF()!;
    const types = (doc.loadPage(0) as mupdf.PDFPage).getAnnotations().map((a: mupdf.PDFAnnotation) => a.getType());
    expect(types).toEqual(["Highlight", "Underline", "StrikeOut", "Ink", "Square", "Circle", "Line", "Line", "FreeText", "Text", "Stamp"]);
    const ft = (doc.loadPage(0) as mupdf.PDFPage).getAnnotations()[8];
    expect(ft.getContents()).toBe("Şirket ğüı");
    // highlight rect maps to MuPDF's y-down space: y = 800 - 715 = 85
    const hb = (doc.loadPage(0) as mupdf.PDFPage).getAnnotations()[0].getBounds();
    expect(Math.round(hb[1])).toBeLessThanOrEqual(86);
    expect((doc.loadPage(1) as mupdf.PDFPage).getAnnotations()).toHaveLength(0);
  });

  it("round-trips annotations as editable objects", async () => {
    const baked = await bakeAnnotations(await blankPdf(2), ["p1", "p2"], { p2: all.slice(0, 3) });
    const imported = await importAnnotations(baked, ["x1", "x2"]);
    expect(imported).not.toBeNull();
    expect(imported!.count).toBe(3);
    expect(imported!.annotations.x2.map((a) => a.id)).toEqual(["h", "u", "s"]);
    // the returned bytes no longer contain them
    const doc = mupdf.Document.openDocument(imported!.bytes, "application/pdf").asPDF()!;
    expect((doc.loadPage(1) as mupdf.PDFPage).getAnnotations()).toHaveLength(0);
  });

  it("returns null when there is nothing to import", async () => {
    expect(await importAnnotations(await blankPdf(1), ["a"])).toBeNull();
  });
});
