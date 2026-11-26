import { useDoc, withBusy, setBusyLabel } from "../state/documentStore";
import { useUi } from "../state/uiStore";
import { errorMessage, openDialog, toast } from "../state/dialogStore";
import { platform } from "../platform";
import { exportDocument } from "./exportDocument";
import { parsePageRanges } from "../core/pdf/pageOps";
import { openFile } from "./fileActions";

const stem = (name: string) => name.replace(/\.pdf$/i, "");

/** PDF → Word (.docx): paragraphs with fonts and styles, images, page sizes. */
export async function exportToWord(): Promise<void> {
  const { doc } = useDoc.getState();
  if (!doc) return;
  try {
    const bytes = await withBusy("Converting to Word…", async () => {
      const pdf = await exportDocument();
      const { pdfToDocx } = await import("../core/convert/pdfToDocx");
      return pdfToDocx(pdf, stem(doc.name), "render", (p, n) => setBusyLabel(`Converting to Word — page ${p + 1} of ${n}`));
    });
    const written = await platform.saveExport(bytes, {
      suggestedName: `${stem(doc.name)}.docx`,
      filterName: "Word document",
      extensions: ["docx"],
    });
    if (written) toast(`Exported ${written.split(/[\\/]/).pop()}`, "success");
  } catch (e) {
    toast(`Word export failed: ${errorMessage(e)}`, "error");
  }
}

/** PDF → plain text. */
export async function exportToText(): Promise<void> {
  const { doc } = useDoc.getState();
  if (!doc) return;
  try {
    const text = await withBusy("Extracting text…", async () => {
      const { pdfToText } = await import("../core/convert/pdfToDocx");
      return pdfToText(await exportDocument());
    });
    // UTF-8 with BOM so Notepad and Excel detect the encoding (Turkish characters).
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text.replace(/\n/g, "\r\n"))]);
    const written = await platform.saveExport(bytes, { suggestedName: `${stem(doc.name)}.txt`, filterName: "Text", extensions: ["txt"] });
    if (written) toast(`Exported ${written.split(/[\\/]/).pop()}`, "success");
  } catch (e) {
    toast(`Text export failed: ${errorMessage(e)}`, "error");
  }
}

/** PDF → images (PNG or JPEG, chosen resolution and pages). */
export async function exportToImages(): Promise<void> {
  const { doc, pageSizes } = useDoc.getState();
  if (!doc) return;
  const n = pageSizes.length;
  const r = await openDialog({
    title: "Export pages as images",
    fields: [
      {
        kind: "radio",
        key: "pages",
        label: "Pages",
        value: n > 1 ? "all" : "current",
        options: [
          { value: "all", label: `All pages (${n})` },
          { value: "current", label: `Current page (${useUi.getState().currentPage + 1})` },
          { value: "range", label: "Page range…" },
        ],
      },
      { kind: "text", key: "range", label: "Range", placeholder: "e.g. 1-3, 7" },
      {
        kind: "select",
        key: "format",
        label: "Format",
        value: "png",
        options: [
          { value: "png", label: "PNG (lossless)" },
          { value: "jpeg", label: "JPEG (smaller files)" },
        ],
      },
      {
        kind: "select",
        key: "dpi",
        label: "Resolution",
        value: "150",
        options: [
          { value: "72", label: "72 DPI (screen)" },
          { value: "150", label: "150 DPI (standard)" },
          { value: "300", label: "300 DPI (print)" },
        ],
      },
    ],
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Export…", variant: "primary" },
    ],
    validate: (v, b) => {
      if (b !== "ok" || v.pages !== "range") return null;
      try {
        parsePageRanges(v.range, n);
        return null;
      } catch (e) {
        return errorMessage(e);
      }
    },
  });
  if (r.button !== "ok") return;
  const pages =
    r.values.pages === "all"
      ? Array.from({ length: n }, (_, i) => i)
      : r.values.pages === "current"
        ? [useUi.getState().currentPage]
        : [...new Set(parsePageRanges(r.values.range, n))];
  const jpeg = r.values.format === "jpeg";
  const dpi = parseInt(r.values.dpi, 10);
  let cancelled = false;
  try {
    const files = await withBusy(
      "Rendering pages…",
      async () => {
        const { openPdf } = await import("../core/pdf/pdfjs");
        const pdf = await openPdf(await exportDocument());
        const out: { name: string; bytes: Uint8Array }[] = [];
        const width = String(n).length;
        try {
          for (let k = 0; k < pages.length && !cancelled; k++) {
            setBusyLabel(`Rendering page ${pages[k] + 1} (${k + 1} of ${pages.length})`);
            const page = await pdf.getPage(pages[k] + 1);
            const viewport = page.getViewport({ scale: dpi / 72 });
            const canvas = document.createElement("canvas");
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvas, viewport }).promise;
            const blob = await new Promise<Blob>((res, rej) =>
              canvas.toBlob((b) => (b ? res(b) : rej(new Error("Rendering failed"))), jpeg ? "image/jpeg" : "image/png", 0.9),
            );
            out.push({
              name: `${stem(doc.name)}-p${String(pages[k] + 1).padStart(width, "0")}.${jpeg ? "jpg" : "png"}`,
              bytes: new Uint8Array(await blob.arrayBuffer()),
            });
            canvas.width = canvas.height = 0;
          }
        } finally {
          void pdf.loadingTask.destroy();
        }
        return out;
      },
      () => (cancelled = true),
    );
    if (cancelled || !files.length) return;
    const written =
      files.length === 1
        ? await platform.saveExport(files[0].bytes, {
            suggestedName: files[0].name,
            filterName: jpeg ? "JPEG image" : "PNG image",
            extensions: jpeg ? ["jpg", "jpeg"] : ["png"],
          })
        : await platform.saveManyExports(files, "Choose a folder for the images");
    if (written) toast(`Exported ${files.length} image${files.length > 1 ? "s" : ""}`, "success");
  } catch (e) {
    toast(`Image export failed: ${errorMessage(e)}`, "error");
  }
}

/** Images → PDF: one page per image, opened as a new document. */
export async function createPdfFromImages(): Promise<void> {
  try {
    const images = await platform.pickImages();
    if (!images.length) return;
    const r = await openDialog({
      title: "Create PDF from images",
      message: `${images.length} image${images.length > 1 ? "s" : ""} selected (in the order chosen).`,
      fields: [
        {
          kind: "radio",
          key: "fit",
          label: "Page size",
          value: "a4",
          options: [
            { value: "a4", label: "A4, image fitted to the page" },
            { value: "image", label: "Same size as each image" },
          ],
        },
      ],
      buttons: [
        { id: "cancel", label: "Cancel" },
        { id: "ok", label: "Create PDF", variant: "primary" },
      ],
    });
    if (r.button !== "ok") return;
    const { imagesToPdf } = await import("../core/convert/imagesToPdf");
    const pdf = await withBusy("Creating PDF…", () => imagesToPdf(images, r.values.fit as "a4" | "image"));
    await openFile({ name: images.length === 1 ? images[0].name.replace(/\.\w+$/, ".pdf") : "Images.pdf", bytes: pdf }, { dirty: true });
  } catch (e) {
    toast(`Could not create the PDF: ${errorMessage(e)}`, "error");
  }
}
