import { setBusyLabel, withBusy } from "../state/documentStore";
import { errorMessage, openDialog, toast } from "../state/dialogStore";
import { platform, type OpenedFile } from "../platform";

type BatchOp = "compress" | "ocr" | "watermark" | "numbers" | "word" | "pdfa" | "text";

const OPS: Record<BatchOp, string> = {
  compress: "Reduce file size (balanced)",
  ocr: "Recognise text (OCR) on scanned pages",
  numbers: "Add page numbers (Sayfa X / Y)",
  watermark: "Add a watermark",
  word: "Convert to Word (.docx)",
  text: "Convert to plain text (.txt)",
  pdfa: "Convert to PDF/A-2b",
};

const stem = (n: string) => n.replace(/\.pdf$/i, "");

/** Page count, or a readable error for damaged files (MuPDF repairs what it can). */
async function countPages(bytes: Uint8Array): Promise<number> {
  const { openMupdf } = await import("../core/mupdf/loader");
  const { doc } = await openMupdf(bytes).catch((e: unknown) => {
    if (/password/i.test(errorMessage(e))) throw e;
    throw new Error("The file is damaged or is not a PDF");
  });
  try {
    const n = doc.countPages();
    if (!n) throw new Error("The file is damaged or has no pages");
    return n;
  } finally {
    doc.destroy();
  }
}

async function processOne(op: BatchOp, f: OpenedFile, n: number, opts: Record<string, string>, isCancelled: () => boolean): Promise<{ name: string; bytes: Uint8Array; kind: "pdf" | "export"; note?: string }> {
  switch (op) {
    case "compress": {
      const { compressPdf, COMPRESS_PRESETS } = await import("../core/optimize/compress");
      const r = await compressPdf(f.bytes, COMPRESS_PRESETS.ebook);
      return { name: `${stem(f.name)} (compressed).pdf`, bytes: r.bytes, kind: "pdf", note: `${Math.round((1 - r.after / r.before) * 100)}% smaller` };
    }
    case "ocr": {
      const { ocrPdfBytes } = await import("./ocrActions");
      const r = await ocrPdfBytes(f.bytes, (opts.lang as "tur+eng") || "tur+eng", isCancelled);
      return { name: `${stem(f.name)} (OCR).pdf`, bytes: r.bytes, kind: "pdf", note: `${r.pages} page${r.pages === 1 ? "" : "s"} recognised` };
    }
    case "numbers":
    case "watermark": {
      const { stampPages } = await import("../core/stamp/stamp");
      const pages = Array.from({ length: n }, (_, i) => i);
      const bytes = await stampPages(f.bytes, {
        pages,
        fileName: f.name,
        ...(op === "numbers"
          ? { footer: { center: "Sayfa {page} / {pages}" }, fontSize: 9 }
          : { watermark: { text: opts.watermark || "TASLAK", size: 72, color: "#d1242f", opacity: 0.2, rotation: 45 } }),
      });
      return { name: `${stem(f.name)} (${op === "numbers" ? "numbered" : "watermarked"}).pdf`, bytes, kind: "pdf" };
    }
    case "word": {
      const { pdfToDocx } = await import("../core/convert/pdfToDocx");
      return { name: `${stem(f.name)}.docx`, bytes: await pdfToDocx(f.bytes, stem(f.name), "render"), kind: "export" };
    }
    case "text": {
      const { pdfToText } = await import("../core/convert/pdfToDocx");
      const t = await pdfToText(f.bytes);
      return { name: `${stem(f.name)}.txt`, bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(t.replace(/\n/g, "\r\n"))]), kind: "export" };
    }
    case "pdfa": {
      if (!platform.isDesktop) throw new Error("PDF/A needs the desktop app");
      const icc = (await platform.readPath("C:\\Windows\\System32\\spool\\drivers\\color\\sRGB Color Space Profile.icm")).bytes;
      const { convertToPdfA } = await import("../core/optimize/preflight");
      return { name: `${stem(f.name)} (PDF-A).pdf`, bytes: await convertToPdfA(f.bytes, icc, stem(f.name), "tr-TR"), kind: "pdf" };
    }
  }
}

/** Applies one operation to many PDFs; results are written to a chosen folder. */
export async function batchDialog() {
  const r = await openDialog({
    title: "Batch processing",
    message: "Apply one operation to many PDF files. The originals are not changed; results are written to a folder you choose.",
    fields: [
      { kind: "radio", key: "op", label: "Operation", value: "compress", options: Object.entries(OPS).map(([value, label]) => ({ value, label })) },
      { kind: "text", key: "watermark", label: "Watermark text (for “Add a watermark”)", value: "TASLAK" },
    ],
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Choose files…", variant: "primary" },
    ],
    width: 520,
  });
  if (r.button !== "ok") return;
  const op = r.values.op as BatchOp;
  const files = await platform.pickPdfs({ multiple: true, title: "Choose the PDFs to process" });
  if (!files.length) return;
  const dir = await platform.pickDirectory("Choose the output folder");
  if (!dir) return;
  let cancelled = false;
  const report: { name: string; ok: boolean; note?: string }[] = [];
  await withBusy(
    "Processing…",
    async () => {
      for (let i = 0; i < files.length && !cancelled; i++) {
        const f = files[i];
        setBusyLabel(`${OPS[op]} — ${i + 1} of ${files.length}: ${f.name}`);
        try {
          const out = await processOne(op, f, await countPages(f.bytes), r.values, () => cancelled);
          await platform.writeInDirectory(dir, out.name, out.bytes, out.kind);
          report.push({ name: f.name, ok: true, note: out.note });
        } catch (e) {
          report.push({ name: f.name, ok: false, note: errorMessage(e) });
        }
      }
    },
    () => (cancelled = true),
  );
  const ok = report.filter((x) => x.ok).length;
  await openDialog({
    title: cancelled ? "Batch processing cancelled" : "Batch processing finished",
    message: `${ok} of ${files.length} file${files.length > 1 ? "s" : ""} processed into ${dir}.`,
    body: () => (
      <div className="compare-list">
        {report.map((x, k) => (
          <div key={k} className={`compare-item ${x.ok ? "inserted" : "deleted"}`}>
            <span className="compare-kind">{x.ok ? "✓" : "✗"}</span>
            <span className="compare-text">
              {x.name}
              {x.note ? ` — ${x.note}` : ""}
            </span>
          </div>
        ))}
      </div>
    ),
    buttons: [{ id: "ok", label: "OK", variant: "primary" }],
  });
  if (!ok) toast("No files were processed successfully.", "error");
}
