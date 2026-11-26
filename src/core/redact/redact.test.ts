import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as mupdf from "mupdf";
import { applyRedactions, findTextAreas } from "./redact";

async function pdf() {
  const doc = await PDFDocument.create();
  doc.setTitle("Secret report");
  doc.setAuthor("Agent Smith");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([600, 800]);
  p.drawText("Customer: Ayse Yilmaz", { x: 50, y: 700, size: 14, font });
  p.drawText("IBAN TR12 0006 4000 0011 2345 6789 01", { x: 50, y: 670, size: 14, font });
  p.drawText("Public information stays.", { x: 50, y: 640, size: 14, font });
  p.drawRectangle({ x: 50, y: 400, width: 100, height: 100, color: rgb(1, 0, 0) });
  return doc.save();
}

const text = (b: Uint8Array) => {
  const d = mupdf.Document.openDocument(b, "application/pdf");
  const t = d.loadPage(0).toStructuredText("preserve-whitespace").asText();
  d.destroy();
  return t;
};

describe("redaction", () => {
  it("finds text and removes it from the file", async () => {
    const bytes = await pdf();
    const areas = await findTextAreas(bytes, "TR12 0006 4000 0011 2345 6789 01");
    expect(areas).toHaveLength(1);
    expect(areas[0].rects.length).toBeGreaterThan(0);
    expect(areas[0].rects[0][1]).toBeGreaterThan(660); // PDF user space (y up)
    const out = await applyRedactions(bytes, areas, { blackBoxes: true, removeMetadata: true });
    const t = text(out);
    expect(t).not.toContain("6789");
    expect(t).toContain("Public information stays.");
    // the removed text is not hidden somewhere in the file either
    expect(new TextDecoder("latin1").decode(out)).not.toContain("6789");
    const d = mupdf.Document.openDocument(out, "application/pdf");
    expect(d.getMetaData("info:Author") ?? "").toBe("");
    d.destroy();
  });

  it("redacts an area (vector graphics and text inside)", async () => {
    const bytes = await pdf();
    const out = await applyRedactions(bytes, [{ pageIndex: 0, rects: [[40, 690, 300, 720]] }], { blackBoxes: false, removeMetadata: false });
    expect(text(out)).not.toContain("Ayse");
    expect(text(out)).toContain("IBAN");
  });
});
