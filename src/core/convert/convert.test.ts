import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { unzipSync, strFromU8 } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { pdfToDocx, pdfToText, wordFontName } from "./pdfToDocx";
import { imagesToPdf } from "./imagesToPdf";

async function richPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  let tr = times;
  try {
    tr = await doc.embedFont(readFileSync("C:/Windows/Fonts/times.ttf"));
  } catch {
    /* non-Windows: WinAnsi only */
  }
  const p = doc.addPage([595.28, 841.89]);
  p.drawText("Quarterly Report", { x: 200, y: 780, size: 24, font: bold });
  ["Sales grew steadily in every region during the quarter,", "driven by strong demand for our new product line."].forEach((t, i) =>
    p.drawText(t, { x: 72, y: 720 - i * 14, size: 11, font: times }),
  );
  p.drawText("Türkçe karakterler: ğüşıöç İĞÜŞÖÇ", { x: 72, y: 660, size: 11, font: tr });
  doc.addPage([841.89, 595.28]).drawText("Second page, landscape", { x: 72, y: 500, size: 14, font: times });
  return doc.save();
}

describe("conversion", () => {
  it("maps PDF font names to Word font names", () => {
    expect(wordFontName("ABCDEF+TimesNewRomanPS-BoldMT", "serif")).toBe("Times New Roman");
    expect(wordFontName("Helvetica-Bold", "sans-serif")).toBe("Arial");
    expect(wordFontName("CourierNewPSMT", "monospace")).toBe("Courier New");
  });

  it("converts a PDF to a valid .docx with text, styles and sections", async () => {
    const docx = await pdfToDocx(await richPdf(), "Report", null);
    const files = unzipSync(docx);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml"]));
    const xml = strFromU8(files["word/document.xml"]);
    expect(xml).toContain("Quarterly Report");
    expect(xml).toContain("Sales grew steadily in every region during the quarter, driven by strong demand");
    expect(xml).toContain("ğüşıöç İĞÜŞÖÇ");
    expect(xml).toContain('<w:jc w:val="center"/>'); // centred title
    expect(xml).toContain("<w:b/>"); // bold title
    expect(xml).toContain('w:orient="landscape"'); // second section
    // Validate every XML part with an independent parser (Python), when available.
    mkdirSync(".playwright-mcp", { recursive: true });
    writeFileSync(".playwright-mcp/test.docx", docx);
    try {
      const out = execFileSync("python", [
        "-c",
        "import zipfile,sys; from xml.dom import minidom; z=zipfile.ZipFile(sys.argv[1]); [minidom.parseString(z.read(n)) for n in z.namelist() if n.endswith('.xml') or n.endswith('.rels')]; print('ok')",
        ".playwright-mcp/test.docx",
      ]).toString();
      expect(out.trim()).toBe("ok");
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") throw e;
    }
  });

  it("embeds images when converting to .docx", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    // 8x8 blue PNG
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGNgYPiPjzCMSmMCAPJ+D/G3n4O7AAAAAElFTkSuQmCC"), (c) => c.charCodeAt(0));
    const img = await doc.embedPng(png);
    page.drawImage(img, { x: 100, y: 500, width: 200, height: 200 });
    const docx = await pdfToDocx(await doc.save(), "Images", "render");
    const files = unzipSync(docx);
    const media = Object.keys(files).filter((k) => k.startsWith("word/media/"));
    expect(media.length).toBe(1);
    expect(files[media[0]].slice(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47])); // PNG
    expect(strFromU8(files["word/document.xml"])).toContain("<w:drawing>");
  });

  it("extracts plain text", async () => {
    const txt = await pdfToText(await richPdf());
    expect(txt).toContain("Quarterly Report");
    expect(txt).toContain("Second page, landscape");
    expect(txt).toContain("\f");
  });

  it("builds a PDF from images", async () => {
    // 2×1 red PNG
    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGP4z8DAwMDAAAAZ/gH/QKiEDgAAAABJRU5ErkJggg=="),
      (c) => c.charCodeAt(0),
    );
    const pdf = await imagesToPdf([{ name: "a.png", bytes: png }, { name: "b.png", bytes: png }], "a4");
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(2);
    // landscape image -> landscape A4
    expect(Math.round(doc.getPage(0).getWidth())).toBe(842);
    await expect(imagesToPdf([{ name: "x.txt", bytes: new Uint8Array([1, 2, 3]) }])).rejects.toThrow();
  });
});
