import { describe, expect, it } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
import * as mupdf from "mupdf";
import { removeStamps, stampPages } from "./stamp";

async function blank(n: number, rotateSecond = false) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([595, 842]);
  if (rotateSecond) doc.getPage(1).setRotation(degrees(90));
  return doc.save();
}

function pageInfo(bytes: Uint8Array, i: number) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const page = doc.loadPage(i);
  const json = JSON.parse(page.toStructuredText("preserve-whitespace").asJSON()) as { blocks: { lines?: { text: string; bbox: { x: number; y: number } }[] }[] };
  const lines = json.blocks.flatMap((b) => b.lines ?? []);
  const b = page.getBounds();
  doc.destroy();
  return { lines, w: b[2] - b[0], h: b[3] - b[1] };
}

describe("headers, footers, Bates, watermark", () => {
  it("adds page numbers, Bates numbers and headers in the right places", async () => {
    const out = await stampPages(await blank(3, true), {
      pages: [0, 1, 2],
      header: { left: "Gizli — {file}", right: "{date}" },
      footer: { center: "Sayfa {page} / {pages}", right: "{bates}" },
      bates: { prefix: "MRM", start: 41, digits: 6 },
      fileName: "rapor.pdf",
    });
    for (let i = 0; i < 3; i++) {
      const { lines, h } = pageInfo(out, i);
      const footer = lines.find((l) => l.text.startsWith("Sayfa"))!;
      expect(footer.text).toBe(`Sayfa ${i + 1} / 3`);
      // footer near the bottom of the page *as displayed* (also on the rotated page)
      expect(footer.bbox.y).toBeGreaterThan(h - 60);
      expect(lines.some((l) => l.text === `MRM${String(41 + i).padStart(6, "0")}`)).toBe(true);
      const header = lines.find((l) => l.text.startsWith("Gizli"))!;
      expect(header.bbox.y).toBeLessThan(60);
    }
  });

  it("adds a rotated, semi-transparent watermark and can replace / remove stamps", async () => {
    const once = await stampPages(await blank(1), { pages: [0], watermark: { text: "TASLAK", size: 72, color: "#d1242f", opacity: 0.25, rotation: 45 } });
    expect(pageInfo(once, 0).lines.some((l) => l.text === "TASLAK")).toBe(true);
    // re-running replaces instead of stacking
    const twice = await stampPages(once, { pages: [0], watermark: { text: "ONAYLI", size: 60, color: "#1a7f37", opacity: 0.3, rotation: 30 } });
    const lines = pageInfo(twice, 0).lines.map((l) => l.text);
    expect(lines).toContain("ONAYLI");
    expect(lines).not.toContain("TASLAK");
    const removed = await removeStamps(twice);
    expect(removed.pages).toBe(1);
    expect(pageInfo(removed.bytes, 0).lines).toHaveLength(0);
  });
});
