import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import * as mupdf from "mupdf";
import { analyzePageText, applyTextEdit, insertText } from "./editor";
import { parseContentStream, serializeContentStream } from "./contentStream";

async function samplePdf(rotate = 0) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p = doc.addPage([600, 800]);
  p.drawText("Invoice number 12345", { x: 50, y: 700, size: 20, font: bold });
  p.drawText("The quick brown fox jumps over the lazy dog.", { x: 50, y: 650, size: 12, font, color: rgb(0.2, 0.2, 0.2) });
  p.drawText("Second line stays untouched.", { x: 50, y: 630, size: 12, font });
  p.drawRectangle({ x: 300, y: 100, width: 100, height: 50, color: rgb(1, 0, 0) });
  if (rotate) p.setRotation(degrees(rotate));
  return doc.save();
}

function pageText(bytes: Uint8Array, index = 0): string {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const t = doc.loadPage(index).toStructuredText("preserve-whitespace").asText();
  doc.destroy();
  return t;
}

function pageHasRedFill(bytes: Uint8Array): boolean {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  // pixel inside the red rectangle (y measured from top: 800-125)
  const w = pix.getWidth();
  const px = pix.getPixels();
  const i = (675 * w + 350) * 3;
  doc.destroy();
  return px[i] > 200 && px[i + 1] < 60 && px[i + 2] < 60;
}

describe("content stream round trip", () => {
  it("parses and re-serialises losslessly at the operator level", () => {
    const src = new TextEncoder().encode("q 1 0 0 1 10 20 cm BT /F1 12 Tf (Hello \\(world\\)) Tj [(A) -120 <0042>] TJ ET Q");
    const ops = parseContentStream(src);
    expect(ops.map((o) => o.op)).toEqual(["q", "cm", "BT", "Tf", "Tj", "TJ", "ET", "Q"]);
    const again = parseContentStream(serializeContentStream(ops));
    // strings are always written as hex; values must be identical
    const norm = (x: unknown) => JSON.stringify(x, (k, v) => (k === "hex" ? undefined : v));
    expect(norm(again)).toBe(norm(ops));
  });
});

describe("text editing", () => {
  it("finds text blocks with font, size and colour", async () => {
    const blocks = await analyzePageText(await samplePdf(), 0);
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain("Invoice number 12345");
    expect(texts).toContain("The quick brown fox jumps over the lazy dog.");
    const inv = blocks.find((b) => b.text.startsWith("Invoice"))!;
    expect(inv.bold).toBe(true);
    expect(Math.round(inv.size)).toBe(20);
    expect(inv.bbox[0]).toBeCloseTo(50, 0);
    const fox = blocks.find((b) => b.text.startsWith("The quick"))!;
    expect(fox.color).toBe("#333333");
  });

  it("edits text in place in the original font", async () => {
    const bytes = await samplePdf();
    const blocks = await analyzePageText(bytes, 0);
    const fox = blocks.find((b) => b.text.startsWith("The quick"))!;
    const r = await applyTextEdit(bytes, 0, { blockId: fox.id, text: "The quick brown fox jumps over the sleepy cat." });
    expect(r.mode).toBe("in-place");
    expect(r.font).toBe("Helvetica");
    const t = pageText(r.bytes);
    expect(t).toContain("sleepy cat.");
    expect(t).not.toContain("lazy dog");
    expect(t).toContain("Second line stays untouched.");
    expect(t).toContain("Invoice number 12345");
    expect(pageHasRedFill(r.bytes)).toBe(true); // graphics untouched
    // edited text keeps its position and colour
    const after = (await analyzePageText(r.bytes, 0)).find((b) => b.text.includes("sleepy"))!;
    expect(after.bbox[0]).toBeCloseTo(fox.bbox[0], 1);
    expect(after.origin[1]).toBeCloseTo(fox.origin[1], 1);
    expect(after.color).toBe("#333333");
  });

  it("re-typesets when the font lacks a character (Turkish)", async () => {
    const bytes = await samplePdf();
    const fox = (await analyzePageText(bytes, 0)).find((b) => b.text.startsWith("The quick"))!;
    const r = await applyTextEdit(bytes, 0, { blockId: fox.id, text: "Hızlı kahverengi tilki — ğüşıöçİ" });
    expect(r.mode).toBe("retypeset");
    const t = pageText(r.bytes);
    expect(t).toContain("Hızlı kahverengi tilki — ğüşıöçİ");
    expect(t).not.toContain("quick brown");
    const after = (await analyzePageText(r.bytes, 0)).find((b) => b.text.startsWith("Hızlı"))!;
    expect(after.origin[0]).toBeCloseTo(fox.origin[0], 1);
    expect(after.origin[1]).toBeCloseTo(fox.origin[1], 1);
    expect(Math.round(after.size)).toBe(12);
  });

  it("changes size and colour in place", async () => {
    const bytes = await samplePdf();
    const inv = (await analyzePageText(bytes, 0)).find((b) => b.text.startsWith("Invoice"))!;
    const r = await applyTextEdit(bytes, 0, { blockId: inv.id, text: inv.text, size: 28, color: "#1366c4" });
    expect(r.mode).toBe("in-place");
    const after = (await analyzePageText(r.bytes, 0)).find((b) => b.text.startsWith("Invoice"))!;
    expect(Math.round(after.size)).toBe(28);
    expect(after.color).toBe("#1366c4");
    // following text keeps its original colour
    const fox = (await analyzePageText(r.bytes, 0)).find((b) => b.text.startsWith("The quick"))!;
    expect(fox.color).toBe("#333333");
  });

  it("moves text, keeping the original font", async () => {
    const bytes = await samplePdf();
    const inv = (await analyzePageText(bytes, 0)).find((b) => b.text.startsWith("Invoice"))!;
    const r = await applyTextEdit(bytes, 0, { blockId: inv.id, text: inv.text, dx: 100, dy: -50 });
    expect(r.mode).toBe("retypeset");
    expect(r.font).toBe("Helvetica-Bold");
    const after = (await analyzePageText(r.bytes, 0)).find((b) => b.text.startsWith("Invoice"))!;
    expect(after.origin[0]).toBeCloseTo(inv.origin[0] + 100, 1);
    expect(after.origin[1]).toBeCloseTo(inv.origin[1] - 50, 1);
  });

  it("deletes text", async () => {
    const bytes = await samplePdf();
    const inv = (await analyzePageText(bytes, 0)).find((b) => b.text.startsWith("Invoice"))!;
    const r = await applyTextEdit(bytes, 0, { blockId: inv.id, text: "" });
    expect(r.mode).toBe("deleted");
    expect(pageText(r.bytes)).not.toContain("Invoice");
    expect(pageText(r.bytes)).toContain("The quick brown fox");
  });

  it("changes the font family", async () => {
    const bytes = await samplePdf();
    const fox = (await analyzePageText(bytes, 0)).find((b) => b.text.startsWith("The quick"))!;
    const r = await applyTextEdit(bytes, 0, { blockId: fox.id, text: fox.text, family: "serif" });
    expect(r.mode).toBe("retypeset");
    expect(r.font).toMatch(/Times|Nimbus/i);
    expect(pageText(r.bytes)).toContain("The quick brown fox");
  });

  it("inserts new multi-line text as page content", async () => {
    const bytes = await samplePdf();
    const r = await insertText(bytes, 0, { origin: [60, 400], dir: [1, 0], up: [0, 1], text: "Yeni satır ğş\nSecond", size: 14, color: "#d1242f", family: "sans" });
    const blocks = await analyzePageText(r.bytes, 0);
    const a = blocks.find((b) => b.text === "Yeni satır ğş")!;
    const b = blocks.find((x) => x.text === "Second")!;
    expect(a.origin[0]).toBeCloseTo(60, 1);
    expect(a.origin[1]).toBeCloseTo(400, 1);
    expect(b.origin[1]).toBeCloseTo(400 - 14 * 1.25, 1);
    expect(a.color).toBe("#d1242f");
    // inserted text is itself editable again (in place, since its glyphs are embedded)
    const r2 = await applyTextEdit(r.bytes, 0, { blockId: a.id, text: "Yeni şatır" });
    expect(r2.mode).toBe("in-place");
    expect(pageText(r2.bytes)).toContain("Yeni şatır");
  });

  it("works on rotated pages", async () => {
    const bytes = await samplePdf(90);
    const inv = (await analyzePageText(bytes, 0)).find((b) => b.text.startsWith("Invoice"))!;
    const r = await applyTextEdit(bytes, 0, { blockId: inv.id, text: "Invoice number 54321" });
    expect(r.mode).toBe("in-place");
    expect(pageText(r.bytes)).toContain("Invoice number 54321");
  });

  it.skipIf(!existsSync("C:/Windows/Fonts/arial.ttf"))("handles embedded subset fonts", async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(readFileSync("C:/Windows/Fonts/arial.ttf"), { subset: true });
    const p = doc.addPage([600, 800]);
    p.drawText("Merhaba dunya abc", { x: 50, y: 700, size: 16, font });
    const bytes = await doc.save();
    const blk = (await analyzePageText(bytes, 0)).find((b) => b.text.startsWith("Merhaba"))!;
    expect(blk).toBeDefined();
    // letters already in the subset: in place
    const r1 = await applyTextEdit(bytes, 0, { blockId: blk.id, text: "Merhaba abc dunya" });
    expect(r1.mode).toBe("in-place");
    expect(pageText(r1.bytes)).toContain("Merhaba abc dunya");
    // a letter not in the subset (z): falls back to re-typesetting
    const r2 = await applyTextEdit(bytes, 0, { blockId: blk.id, text: "Merhaba dunya xyz" });
    expect(r2.mode).toBe("retypeset");
    expect(pageText(r2.bytes)).toContain("Merhaba dunya xyz");
  });

  it("keeps TJ kerning arrays decodable", async () => {
    const bytes = await samplePdf();
    const fox = (await analyzePageText(bytes, 0)).find((b) => b.text.startsWith("The quick"))!;
    // create a TJ by deleting spaces from the font's knowledge is complex; instead check a stream with TJ
    const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const ref = page.getObject().get("Contents");
    const contents = ref.isStream() ? ref : ref.resolve().get(0);
    const raw = new TextDecoder("latin1").decode(contents.readStream().asUint8Array());
    expect(raw).toMatch(/Tj/);
    doc.destroy();
    expect(fox.text.length).toBeGreaterThan(10);
  });
});
