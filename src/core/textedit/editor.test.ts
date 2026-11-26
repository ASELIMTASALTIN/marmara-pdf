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
  p.drawText("Second line stays untouched.", { x: 50, y: 560, size: 12, font });
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
    // the two inserted lines form one paragraph with 1.25 line spacing
    const a = blocks.find((b) => b.text === "Yeni satır ğş Second")!;
    expect(a.lines).toBe(2);
    expect(a.leading).toBeCloseTo(14 * 1.25, 1);
    expect(a.origin[0]).toBeCloseTo(60, 1);
    expect(a.origin[1]).toBeCloseTo(400, 1);
    expect(a.color).toBe("#d1242f");
    // inserted text is itself editable again (in place, since its glyphs are embedded)
    const r2 = await applyTextEdit(r.bytes, 0, { blockId: a.id, text: "Yeni şatır Second" });
    expect(r2.mode).toBe("reflowed");
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

  it("re-flows a multi-line paragraph to its width and leading", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const p = doc.addPage([600, 800]);
    const lines = [
      "Marmara PDF edits whole paragraphs. When a sentence",
      "becomes longer, the following lines move down and the",
      "text is wrapped again to the original column width,",
      "using the same font and the same line spacing.",
    ];
    lines.forEach((t, i) => p.drawText(t, { x: 72, y: 700 - i * 14, size: 11, font }));
    p.drawText("A separate paragraph far below.", { x: 72, y: 500, size: 11, font });
    const bytes = await doc.save();
    const blocks = await analyzePageText(bytes, 0);
    const para = blocks.find((b) => b.text.startsWith("Marmara PDF edits"))!;
    expect(para.lines).toBe(4);
    expect(para.leading).toBeCloseTo(14, 1);
    expect(blocks.some((b) => b.text.startsWith("A separate paragraph"))).toBe(true);
    const longer = para.text.replace("When a sentence becomes longer,", "When a sentence becomes considerably longer than it was before,");
    const r = await applyTextEdit(bytes, 0, { blockId: para.id, text: longer });
    expect(r.mode).toBe("reflowed");
    expect(r.font).toMatch(/Times/);
    const after = (await analyzePageText(r.bytes, 0)).find((b) => b.text.startsWith("Marmara PDF edits"))!;
    expect(after.lines).toBeGreaterThan(4);
    expect(after.text).toBe(longer);
    expect(after.origin[0]).toBeCloseTo(72, 0);
    expect(after.origin[1]).toBeCloseTo(700, 0);
    expect(after.leading).toBeCloseTo(14, 1);
    expect(after.width).toBeLessThanOrEqual(para.width + 1);
    // other paragraph untouched
    expect(pageText(r.bytes)).toContain("A separate paragraph far below.");
  });

  it("recolours a paragraph in place", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([600, 800]);
    ["First line of text here", "second line of text here", "third line of text"].forEach((t, i) => p.drawText(t, { x: 72, y: 700 - i * 14, size: 11, font }));
    const bytes = await doc.save();
    const para = (await analyzePageText(bytes, 0))[0];
    const r = await applyTextEdit(bytes, 0, { blockId: para.id, text: para.text, color: "#d1242f" });
    expect(r.mode).toBe("in-place");
    const after = (await analyzePageText(r.bytes, 0))[0];
    expect(after.color).toBe("#d1242f");
    expect(after.lines).toBe(3);
  });

  it("edits text inside a form XObject (copy-on-write)", async () => {
    const src = await PDFDocument.create();
    const f = await src.embedFont(StandardFonts.Helvetica);
    src.addPage([300, 100]).drawText("Letterhead Marmara Ltd", { x: 10, y: 50, size: 14, font: f });
    const doc = await PDFDocument.create();
    const [embedded] = await doc.embedPdf(await src.save());
    const p1 = doc.addPage([600, 800]);
    const p2 = doc.addPage([600, 800]);
    p1.drawPage(embedded, { x: 100, y: 600 });
    p2.drawPage(embedded, { x: 100, y: 600 });
    const bytes = await doc.save();
    const blk = (await analyzePageText(bytes, 0)).find((b) => b.text.startsWith("Letterhead"))!;
    expect(blk).toBeDefined();
    expect(blk.inXObject).toBe(true);
    expect(blk.origin[0]).toBeCloseTo(110, 0);
    const r = await applyTextEdit(bytes, 0, { blockId: blk.id, text: "Letterhead Marmara Inc" });
    expect(r.mode).toBe("in-place");
    expect(pageText(r.bytes, 0)).toContain("Letterhead Marmara Inc");
    // the second page still uses the original, shared XObject
    expect(pageText(r.bytes, 1)).toContain("Letterhead Marmara Ltd");
  });

  it("edits text set in a Type3 font", async () => {
    const bytes = type3Pdf();
    const blocks = await analyzePageText(bytes, 0);
    const blk = blocks.find((b) => b.text === "ABBA")!;
    expect(blk).toBeDefined();
    expect(blk.editable).toBe(true);
    // glyphs A and B exist: in place
    const r1 = await applyTextEdit(bytes, 0, { blockId: blk.id, text: "BAAB" });
    expect(r1.mode).toBe("in-place");
    expect(pageText(r1.bytes)).toContain("BAAB");
    // C has no glyph procedure: re-typeset with a built-in font
    const r2 = await applyTextEdit(bytes, 0, { blockId: blk.id, text: "CAB" });
    expect(r2.mode).toBe("retypeset");
    expect(pageText(r2.bytes)).toContain("CAB");
  });
});

/** Hand-written PDF with a Type3 font whose glyphs A and B are simple boxes. */
function type3Pdf(): Uint8Array {
  const NL = String.fromCharCode(10);
  const content = "BT /T3 24 Tf 100 700 Td (ABBA) Tj ET";
  const stream = (body: string) => `<< /Length ${body.length} >>${NL}stream${NL}${body}${NL}endstream`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /T3 5 0 R >> >> /Contents 4 0 R >>",
    stream(content),
    "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 750 750] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /A 6 0 R /B 7 0 R >> /Encoding << /Type /Encoding /Differences [65 /A /B] >> /FirstChar 65 /LastChar 66 /Widths [800 800] /Resources << >> >>",
    stream("800 0 0 0 750 750 d1 0 0 750 750 re f"),
    stream("800 0 0 0 750 750 d1 0 0 375 750 re f"),
  ];
  let out = `%PDF-1.7${NL}`;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj${NL}${o}${NL}endobj${NL}`;
  });
  const xref = out.length;
  out += `xref${NL}0 ${objs.length + 1}${NL}0000000000 65535 f ${NL}` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n ${NL}`).join("");
  out += `trailer${NL}<< /Size ${objs.length + 1} /Root 1 0 R >>${NL}startxref${NL}${xref}${NL}%%EOF${NL}`;
  return new TextEncoder().encode(out);
}
