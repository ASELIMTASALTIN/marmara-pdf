import { existsSync } from "node:fs";
import { openMupdf, saveMupdf } from "../../core/mupdf/loader";
import { defineCommand, P, UsageError, WRITES } from "../registry";
import { guardSignatures, loadPdf, mb, readBytes, stem, writePdf } from "../io";

const WINDOWS_SRGB = "C:\\Windows\\System32\\spool\\drivers\\color\\sRGB Color Space Profile.icm";

defineCommand({
  name: "compress",
  group: "Optimise & archive",
  summary: "Reduce file size: downsample and re-compress images, remove duplicates and unused objects.",
  params: {
    input: P.input,
    preset: { type: "string", enum: ["screen", "ebook", "print", "lossless"], description: "screen (72 dpi), ebook (150 dpi, default), print (300 dpi), lossless (no image changes).", default: "ebook" },
    image_dpi: { type: "integer", description: "Override the target image resolution (0 = keep images)." },
    jpeg_quality: { type: "integer", description: "Override the JPEG quality 1–100." },
    ...WRITES,
    break_signatures: P.breakSignatures,
  },
  examples: ["compress scan.pdf --preset screen"],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    guardSignatures(input, a);
    const { compressPdf, COMPRESS_PRESETS } = await import("../../core/optimize/compress");
    const preset = COMPRESS_PRESETS[a.preset as string];
    const r = await compressPdf(input.bytes, { imageDpi: (a.image_dpi as number) ?? preset.imageDpi, jpegQuality: (a.jpeg_quality as number) ?? preset.jpegQuality }, (d, t) => ctx.progress(`Images ${d}/${t}`));
    if (r.after >= r.before) return { output: null, before_bytes: r.before, message: "The file is already well optimised; it could not be made smaller." };
    return {
      output: await writePdf(ctx, a, input, r.bytes, "compressed"),
      before_bytes: r.before,
      after_bytes: r.after,
      saved: `${mb(r.before)} → ${mb(r.after)} (−${Math.round((1 - r.after / r.before) * 100)}%)`,
      images_recompressed: r.imagesRecompressed,
    };
  },
});

defineCommand({
  name: "check",
  group: "Optimise & archive",
  summary: "Document check (preflight): accessibility, PDF/A archiving and print problems, fonts, and which issues fix can repair.",
  readOnly: true,
  params: { input: P.input, password: P.password },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const { preflight } = await import("../../core/optimize/preflight");
    const rep = await preflight(input.bytes, !!input.password);
    const count = (l: string) => rep.items.filter((i) => i.level === l).length;
    return { pdf_version: rep.version, pages: rep.pages, errors: count("error"), warnings: count("warning"), items: rep.items, fonts: rep.fonts };
  },
});

defineCommand({
  name: "fix",
  group: "Optimise & archive",
  summary: "Repair what check reports as fixable: document title and language, show title in the window, remove JavaScript.",
  params: {
    input: P.input,
    title: { type: "string", description: "Document title (default: existing title or file name)." },
    lang: { type: "string", description: "Document language, e.g. tr-TR or en-US." },
    display_title: { type: "boolean", description: "Show the title instead of the file name in viewers (default true).", default: true },
    remove_javascript: { type: "boolean", description: "Remove JavaScript actions." },
    ...WRITES,
    break_signatures: P.breakSignatures,
  },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    guardSignatures(input, a);
    const { fixDocument } = await import("../../core/optimize/preflight");
    const { doc } = await openMupdf(input.bytes);
    const existing = doc.getMetaData("info:Title");
    doc.destroy();
    const out = await fixDocument(input.bytes, {
      title: (a.title as string) ?? (existing || stem(input.name)),
      lang: a.lang as string | undefined,
      displayTitle: a.display_title as boolean,
      removeJavaScript: !!a.remove_javascript,
    });
    return { output: await writePdf(ctx, a, input, out, "fixed") };
  },
});

defineCommand({
  name: "pdfa",
  group: "Optimise & archive",
  summary: "Convert to PDF/A-2b for archiving (sRGB output intent, XMP metadata, embedded fonts); reports remaining issues.",
  details: "Best effort: the result has not been validated with veraPDF. Uses the Windows sRGB colour profile unless --icc-profile is given. Encrypted output is not allowed by PDF/A, so the password is removed.",
  params: {
    input: P.input,
    title: { type: "string", description: "Document title (default: existing title or file name)." },
    lang: { type: "string", description: "Document language (default tr-TR).", default: "tr-TR" },
    icc_profile: { type: "path", description: "sRGB ICC profile to embed (default: the Windows sRGB profile)." },
    output: P.output,
    overwrite: P.overwrite,
    password: P.password,
    break_signatures: P.breakSignatures,
  },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    guardSignatures(input, a);
    const iccPath = (a.icc_profile as string) ?? WINDOWS_SRGB;
    if (!a.icc_profile && !existsSync(WINDOWS_SRGB)) throw new UsageError("The Windows sRGB profile was not found; pass --icc-profile <sRGB .icc/.icm>.");
    const icc = readBytes(ctx, iccPath);
    const { convertToPdfA, preflight } = await import("../../core/optimize/preflight");
    const { doc } = await openMupdf(input.bytes);
    const existing = doc.getMetaData("info:Title");
    doc.destroy();
    const out = await convertToPdfA(input.bytes, icc, (a.title as string) ?? (existing || stem(input.name)), a.lang as string);
    const rep = await preflight(out, false);
    const remaining = rep.items.filter((i) => i.group === "Archiving (PDF/A)" && i.level === "error").map((i) => i.title + (i.detail ? ` (${i.detail})` : ""));
    const path = await writePdf(ctx, a, { ...input, password: undefined }, out, "pdfa");
    return { output: path, conformance: "PDF/A-2b (not validated with veraPDF)", remaining_issues: remaining };
  },
});

defineCommand({
  name: "set-metadata",
  group: "Optimise & archive",
  summary: "Set document properties: title, author, subject, keywords, creator.",
  params: {
    input: P.input,
    title: { type: "string", description: "Title." },
    author: { type: "string", description: "Author." },
    subject: { type: "string", description: "Subject." },
    keywords: { type: "string", description: "Keywords (comma separated)." },
    creator: { type: "string", description: "Creating application." },
    ...WRITES,
  },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const keys = { title: "info:Title", author: "info:Author", subject: "info:Subject", keywords: "info:Keywords", creator: "info:Creator" } as const;
    const set = Object.entries(keys).filter(([k]) => a[k] !== undefined);
    if (!set.length) throw new UsageError("Give at least one of --title, --author, --subject, --keywords, --creator.");
    const { doc } = await openMupdf(input.bytes);
    try {
      for (const [k, key] of set) doc.setMetaData(key, a[k] as string);
      const out = saveMupdf(doc, input.signatures && !input.password && doc.canBeSavedIncrementally() ? "incremental" : "compress");
      return { output: await writePdf(ctx, a, input, out, "edited"), metadata: Object.fromEntries(set.map(([k]) => [k, a[k]])) };
    } finally {
      doc.destroy();
    }
  },
});
