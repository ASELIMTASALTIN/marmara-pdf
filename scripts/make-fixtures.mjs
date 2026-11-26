// Generates PDFs used for manual and automated testing into test-fixtures/.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import * as mupdf from "mupdf";
import fontkit from "@pdf-lib/fontkit";
import { existsSync, readFileSync } from "node:fs";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "test-fixtures");
mkdirSync(out, { recursive: true });

async function sample() {
  const doc = await PDFDocument.create();
  doc.setTitle("Marmara sample");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const sizes = [
    [595.28, 841.89],
    [595.28, 841.89],
    [841.89, 595.28],
    [612, 792],
    [595.28, 841.89],
  ];
  sizes.forEach(([w, h], i) => {
    const p = doc.addPage([w, h]);
    p.drawRectangle({ x: 0, y: h - 70, width: w, height: 70, color: rgb(0.08, 0.4, 0.77) });
    p.drawText(`Page ${i + 1} - Marmara PDF test document`, { x: 40, y: h - 45, size: 20, font: bold, color: rgb(1, 1, 1) });
    const lines = [
      "The quick brown fox jumps over the lazy dog.",
      "Searching should find the word lighthouse on several pages.",
      `This page is number ${i + 1} and has a unique token TOKEN${i + 1}.`,
      "Istanbul and the Bosphorus connect two continents.",
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
      "Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
    ];
    lines.forEach((t, k) => p.drawText(t, { x: 40, y: h - 120 - k * 24, size: 13, font, color: rgb(0.1, 0.1, 0.12) }));
    if (i % 2 === 0) p.drawText("lighthouse", { x: 40, y: 80, size: 16, font: bold, color: rgb(0.7, 0.1, 0.1) });
    p.drawCircle({ x: w - 90, y: 120, size: 40, color: rgb(0.95, 0.75, 0.1), opacity: 0.8 });
  });
  doc.getPage(3).setRotation(degrees(90));
  return doc.save();
}

async function large(n) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (let i = 0; i < n; i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawText(`Large document page ${i + 1} of ${n}`, { x: 50, y: 780, size: 22, font });
    for (let k = 0; k < 30; k++)
      p.drawText(`Line ${k + 1}: content for performance testing, page ${i + 1}.`, { x: 50, y: 740 - k * 22, size: 11, font });
  }
  return doc.save();
}

function encrypted(bytes) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const buf = doc.asPDF().saveToBuffer("encrypt=aes-256,user-password=secret,owner-password=owner");
  return buf.asUint8Array().slice();
}

/** A "scanned" PDF: pages are images only, no text layer. */
async function scanned() {
  // Source pages with Turkish text (Arial supports ğüşıöç), rendered to images.
  const src = await PDFDocument.create();
  src.registerFontkit(fontkit);
  const arial = "C:/Windows/Fonts/arial.ttf";
  const font = existsSync(arial) ? await src.embedFont(readFileSync(arial)) : await src.embedFont(StandardFonts.Helvetica);
  const texts = [
    ["Scanned Invoice 2026", "Customer: Marmara Shipping Ltd.", "Total amount due: 1,250.00 EUR", "Thank you for your business."],
    ["Taranmış Belge", "Müşteri: Ahmet Yılmaz", "Ödeme tarihi: 15 Aralık 2026", "Şirketimiz İstanbul'dadır."],
  ];
  for (const lines of texts) {
    const p = src.addPage([595.28, 841.89]);
    lines.forEach((t, k) => p.drawText(t, { x: 60, y: 760 - k * 40, size: k ? 18 : 28, font }));
  }
  const srcBytes = await src.save();
  const mdoc = mupdf.Document.openDocument(srcBytes, "application/pdf");
  const out = await PDFDocument.create();
  for (let i = 0; i < mdoc.countPages(); i++) {
    const pix = mdoc.loadPage(i).toPixmap(mupdf.Matrix.scale(150 / 72, 150 / 72), mupdf.ColorSpace.DeviceGray, false, true);
    const png = await out.embedPng(pix.asPNG());
    const page = out.addPage([595.28, 841.89]);
    page.drawImage(png, { x: 0, y: 0, width: 595.28, height: 841.89 });
  }
  return out.save();
}

async function formPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  const form = doc.getForm();
  const label = (t, y) => page.drawText(t, { x: 50, y, size: 12, font });
  page.drawText("Application form", { x: 50, y: 780, size: 22, font });
  label("Full name", 730);
  form.createTextField("applicant.name").addToPage(page, { x: 160, y: 722, width: 280, height: 22 });
  label("Comments", 680);
  const c = form.createTextField("comments");
  c.enableMultiline();
  c.addToPage(page, { x: 160, y: 600, width: 280, height: 90 });
  label("I agree to the terms", 560);
  form.createCheckBox("agree").addToPage(page, { x: 200, y: 556, width: 16, height: 16 });
  label("Preferred colour", 520);
  const r = form.createRadioGroup("colour");
  r.addOptionToPage("red", page, { x: 200, y: 516, width: 16, height: 16 });
  r.addOptionToPage("blue", page, { x: 240, y: 516, width: 16, height: 16 });
  label("City", 480);
  const d = form.createDropdown("city");
  d.addOptions(["Istanbul", "Ankara", "Izmir"]);
  d.addToPage(page, { x: 160, y: 474, width: 160, height: 22 });
  return doc.save();
}

/** A page with a justified multi-line paragraph and a second paragraph (for re-flow tests). */
async function paragraphPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const p = doc.addPage([595.28, 841.89]);
  p.drawText("Annual letter", { x: 72, y: 760, size: 20, font: bold });
  const text =
    "Marmara PDF edits whole paragraphs. When a sentence becomes longer, the following lines move down and the text is wrapped again to the original column width, using the same font and the same line spacing as before. Justified paragraphs stay justified.";
  const W = 420;
  const words = text.split(" ");
  const lines = [];
  let cur = [];
  for (const w of words) {
    const t = [...cur, w].join(" ");
    if (font.widthOfTextAtSize(t, 12) > W && cur.length) {
      lines.push(cur);
      cur = [w];
    } else cur.push(w);
  }
  lines.push(cur);
  lines.forEach((ws, i) => {
    const y = 720 - i * 16;
    if (i === lines.length - 1) return p.drawText(ws.join(" "), { x: 72, y, size: 12, font });
    const gap = (W - font.widthOfTextAtSize(ws.join(""), 12)) / (ws.length - 1);
    let x = 72;
    for (const w of ws) {
      p.drawText(w, { x, y, size: 12, font });
      x += font.widthOfTextAtSize(w, 12) + gap;
    }
  });
  p.drawText("A second, separate paragraph further down the page.", { x: 72, y: 560, size: 12, font });
  return doc.save();
}

const s = await sample();
writeFileSync(join(out, "paragraph.pdf"), await paragraphPdf());
writeFileSync(join(out, "form.pdf"), await formPdf());
writeFileSync(join(out, "scanned.pdf"), await scanned());
writeFileSync(join(out, "sample.pdf"), s);
writeFileSync(join(out, "second.pdf"), await large(3));
writeFileSync(join(out, "large-400.pdf"), await large(400));
writeFileSync(join(out, "protected.pdf"), encrypted(s));
writeFileSync(join(out, "corrupt.pdf"), Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >>\ngarbage garbage"));
console.log("fixtures written to", out);
