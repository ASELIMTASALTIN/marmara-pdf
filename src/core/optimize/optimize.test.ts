import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import * as mupdf from "mupdf";
import { compressPdf, COMPRESS_PRESETS } from "./compress";
import { convertToPdfA, fixDocument, preflight } from "./preflight";

/** PDF with a large noisy (photo-like) RGB image drawn small. */
async function imagePdf() {
  const w = 1600;
  const h = 1200;
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  const px = pix.getPixels();
  let seed = 1;
  for (let i = 0; i < px.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    px[i] = (i % 3 === 0 ? (i / 3 / w) % 255 : 0) ^ (seed & 31);
  }
  const png = pix.asPNG();
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png);
  doc.addPage([595, 842]).drawImage(img, { x: 50, y: 400, width: 200, height: 150 });
  return doc.save();
}

describe("optimise", () => {
  it("downsamples oversized images and shrinks the file", async () => {
    const bytes = await imagePdf();
    const r = await compressPdf(bytes, COMPRESS_PRESETS.ebook);
    expect(r.imagesRecompressed).toBe(1);
    expect(r.after).toBeLessThan(r.before * 0.5);
    // still a valid PDF with the image at reduced resolution (150 DPI over 200pt ≈ 417 px)
    const doc = mupdf.Document.openDocument(r.bytes, "application/pdf");
    const pixOut = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
    expect(pixOut.getWidth()).toBe(595);
    doc.destroy();
  });

  it("lossless mode never grows the file", async () => {
    const bytes = await imagePdf();
    const r = await compressPdf(bytes, COMPRESS_PRESETS.lossless);
    expect(r.imagesRecompressed).toBe(0);
    expect(r.after).toBeLessThanOrEqual(r.before);
  });
});

describe("preflight", () => {
  it("reports missing title/language, untagged and non-embedded fonts, then fixes metadata", async () => {
    const doc = await PDFDocument.create();
    const f = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage().drawText("Hello", { x: 50, y: 700, font: f, size: 12 });
    const bytes = await doc.save();
    const rep = await preflight(bytes);
    const byId = Object.fromEntries(rep.items.map((i) => [i.id, i]));
    expect(byId.title.level).toBe("error");
    expect(byId.lang.level).toBe("error");
    expect(byId.tagged.level).toBe("warning");
    expect(byId.fonts.level).toBe("error"); // standard Helvetica is not embedded
    const fixed = await fixDocument(bytes, { title: "Rapor", lang: "tr-TR", displayTitle: true });
    const rep2 = await preflight(fixed);
    const by2 = Object.fromEntries(rep2.items.map((i) => [i.id, i]));
    expect(by2.title.level).toBe("pass");
    expect(by2.lang.level).toBe("pass");
    expect(by2.displaytitle.level).toBe("pass");
  });

  const icc = "C:/Windows/System32/spool/drivers/color/sRGB Color Space Profile.icm";
  it.skipIf(!existsSync(icc) || !existsSync("C:/Windows/Fonts/arial.ttf"))("converts to PDF/A-2b with identification and output intent", async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const f = await doc.embedFont(readFileSync("C:/Windows/Fonts/arial.ttf"), { subset: true });
    doc.addPage().drawText("Arşiv belgesi", { x: 50, y: 700, font: f, size: 14 });
    const out = await convertToPdfA(await doc.save(), readFileSync(icc), "Arşiv", "tr-TR");
    const rep = await preflight(out);
    const by = Object.fromEntries(rep.items.map((i) => [i.id, i]));
    expect(by.pdfa.level).toBe("pass");
    expect(by.fonts.level).toBe("pass");
    expect(by.js.level).toBe("pass");
    expect(new TextDecoder("latin1").decode(out)).toContain("pdfaid:part>2");
  });
});
