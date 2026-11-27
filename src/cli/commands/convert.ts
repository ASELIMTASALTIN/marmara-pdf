import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { invertMatrix, loadMupdf, openMupdf, transformPoint, type Matrix } from "../../core/mupdf/loader";
import type { OcrLanguage } from "../../core/ocr/recognize";
import type { OcrLineGeom } from "../../core/ocr/textLayer";
import { defineCommand, P, UsageError, WRITES } from "../registry";
import { fileInDir, guardSignatures, loadPdf, outputDir, outputPath, readBytes, resolvePath, selectPages, stem, writeAtomic, writePdf } from "../io";
import { pageTextOf } from "../text";

/** Finds the Tesseract language data (CLI package, or the dev tree). */
function tessdataDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MARMARA_TESSDATA,
    join(here, "tessdata"),
    join(here, "..", "tessdata"),
    join(process.cwd(), "public", "vendor", "tesseract", "lang"),
    join(here, "..", "public", "vendor", "tesseract", "lang"),
    join(here, "..", "..", "public", "vendor", "tesseract", "lang"),
    join(here, "..", "..", "..", "public", "vendor", "tesseract", "lang"),
  ].filter(Boolean) as string[];
  const hit = candidates.find((d) => existsSync(join(d, "tur.traineddata.gz")) && existsSync(join(d, "eng.traineddata.gz")));
  if (!hit) throw new Error("OCR language data (tur/eng.traineddata.gz) not found. Set MARMARA_TESSDATA to its folder.");
  return hit;
}

defineCommand({
  name: "ocr",
  group: "OCR & convert",
  summary: "Recognise text on scanned pages (Turkish + English, offline) and add an invisible, searchable and selectable text layer.",
  details: "By default only pages without real text are processed; --force re-runs OCR on every selected page (an earlier OCR layer is replaced).",
  params: {
    input: P.input,
    pages: P.pages,
    lang: { type: "string", enum: ["tur+eng", "tur", "eng"], description: "Language model (default tur+eng; English pages are re-read with the English model).", default: "tur+eng" },
    force: { type: "boolean", description: "Also process pages that already have text." },
    dpi: { type: "integer", description: "Rendering resolution (default 300).", default: 300 },
    ...WRITES,
    break_signatures: P.breakSignatures,
  },
  examples: ["ocr scan.pdf", "ocr scan.pdf --pages 2-3 --lang eng"],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    guardSignatures(input, a);
    const mupdf = await loadMupdf();
    const { configureOcr, recognizeAuto, terminateOcr } = await import("../../core/ocr/recognize");
    const { toGeometry } = await import("../../core/ocr/geometry");
    const { addOcrTextLayers } = await import("../../core/ocr/textLayer");
    configureOcr({ langPath: tessdataDir(), gzip: true });
    const { doc } = await openMupdf(input.bytes);
    const results: { pageIndex: number; lines: OcrLineGeom[] }[] = [];
    const report: { page: number; words: number; language: string }[] = [];
    const skipped: number[] = [];
    try {
      const sel = selectPages(a.pages, doc.countPages());
      for (const i of sel) {
        if (!a.force && pageTextOf(doc, i).replace(/\s/g, "").length >= 12) {
          skipped.push(i + 1);
          continue;
        }
        ctx.progress(`Recognising page ${i + 1}…`);
        const page = doc.loadPage(i) as import("mupdf").PDFPage;
        const b = page.getBounds();
        const s = Math.min((a.dpi as number) / 72, 4200 / Math.max(b[2] - b[0], b[3] - b[1]));
        const pix = page.toPixmap([s, 0, 0, s, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
        const png = pix.asPNG();
        pix.destroy?.();
        const { lines, usedLang } = await recognizeAuto(Buffer.from(png), a.lang as OcrLanguage);
        const inv = invertMatrix(page.getTransform() as Matrix);
        const vp = { scale: s, convertToPdfPoint: (x: number, y: number) => transformPoint(inv, x / s, y / s) };
        results.push({ pageIndex: i, lines: toGeometry(lines, vp) });
        report.push({ page: i + 1, words: lines.reduce((n, l) => n + l.words.length, 0), language: usedLang });
      }
    } finally {
      doc.destroy();
      await terminateOcr();
    }
    if (!results.length) return { output: null, recognised_pages: [], skipped_pages_with_text: skipped, message: "No pages needed OCR (use --force to process pages that already have text)." };
    const out = await addOcrTextLayers(input.bytes, results);
    return { output: await writePdf(ctx, a, input, out, "ocr"), recognised_pages: report, skipped_pages_with_text: skipped.length ? skipped : undefined };
  },
});

defineCommand({
  name: "to-word",
  group: "OCR & convert",
  summary: "Convert to an editable Word document (.docx): paragraphs, fonts, bold/italic, alignment, images, page sizes.",
  params: {
    input: P.input,
    images: { type: "string", enum: ["render", "none"], description: "Include images (rendered from the page) or leave them out (default render).", default: "render" },
    output: { ...P.output, description: "Result .docx. Default: <name>.docx next to the input." },
    overwrite: P.overwrite,
    password: P.password,
  },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const { pdfToDocx } = await import("../../core/convert/pdfToDocx");
    const bytes = await pdfToDocx(input.bytes, stem(input.name), a.images === "none" ? null : "render", (p, t) => ctx.progress(`Page ${p}/${t}`));
    const path = a.output ? outputPath(ctx, a, input.path, "", ".docx", false) : writeTo(input.path, ".docx", !!a.overwrite);
    writeAtomic(path, bytes);
    return { output: path, size_bytes: bytes.length };
  },
});

function writeTo(near: string, ext: string, overwrite: boolean) {
  return fileInDir(dirname(near), `${stem(near)}${ext}`, overwrite);
}

defineCommand({
  name: "to-images",
  group: "OCR & convert",
  summary: "Render pages to PNG or JPEG images (pixel = point × dpi / 72; useful for looking at a page).",
  params: {
    input: P.input,
    pages: P.pages,
    dpi: { type: "integer", description: "Resolution (default 150).", default: 150 },
    format: { type: "string", enum: ["png", "jpg"], description: "Image format (default png).", default: "png" },
    quality: { type: "integer", description: "JPEG quality 1–100 (default 85).", default: 85 },
    output_dir: { type: "path", description: "Folder for the images. Default: <name>-images next to the input." },
    overwrite: { type: "boolean", description: "Replace existing images in the folder." },
    password: P.password,
  },
  examples: ["to-images report.pdf --pages 1 --dpi 100"],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const dpi = a.dpi as number;
    if (dpi < 18 || dpi > 1200) throw new UsageError("--dpi must be 18–1200.");
    const mupdf = await loadMupdf();
    const { doc } = await openMupdf(input.bytes);
    const dir = outputDir(ctx, a, input.path, "images");
    const files = [];
    try {
      const sel = selectPages(a.pages, doc.countPages());
      const digits = String(doc.countPages()).length;
      for (const i of sel) {
        const s = dpi / 72;
        const pix = doc.loadPage(i).toPixmap([s, 0, 0, s, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
        const bytes = a.format === "jpg" ? pix.asJPEG(a.quality as number) : pix.asPNG();
        const path = fileInDir(dir, `${stem(input.name)}-${String(i + 1).padStart(digits, "0")}.${a.format}`, !!a.overwrite);
        writeAtomic(path, bytes);
        files.push({ page: i + 1, output: path, width_px: pix.getWidth(), height_px: pix.getHeight() });
        pix.destroy?.();
      }
    } finally {
      doc.destroy();
    }
    return { output_dir: dir, dpi, files };
  },
});

defineCommand({
  name: "images-to-pdf",
  group: "OCR & convert",
  summary: "Make a PDF from PNG/JPEG images, one page per image.",
  params: {
    images: { type: "path[]", description: "Image files in page order.", required: true, positional: true },
    fit: { type: "string", enum: ["a4", "image"], description: "a4 = fit on A4 pages (default), image = page size of each image.", default: "a4" },
    output: { ...P.output, description: "Result PDF. Default: <first image>.pdf next to it." },
    overwrite: P.overwrite,
  },
  examples: ["images-to-pdf scan1.jpg scan2.jpg -o scans.pdf"],
  async run(a, ctx) {
    const list = a.images as string[];
    const images = list.map((p) => ({ name: p, bytes: readBytes(ctx, p) }));
    const { imagesToPdf } = await import("../../core/convert/imagesToPdf");
    const bytes = await imagesToPdf(images, a.fit as "a4" | "image");
    const first = resolvePath(ctx, list[0]);
    const path = a.output ? outputPath(ctx, a, first, "", ".pdf", false) : writeTo(first, ".pdf", false);
    writeAtomic(path, bytes);
    return { output: path, pages: images.length };
  },
});

