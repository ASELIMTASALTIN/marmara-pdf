import { useDoc, withBusy, setBusyLabel } from "../state/documentStore";
import { useUi } from "../state/uiStore";
import { errorMessage, openDialog, toast } from "../state/dialogStore";
import { parsePageRanges } from "../core/pdf/pageOps";
import { exportDocument } from "./exportDocument";

/**
 * Prints the document (with annotations and form values) through the system
 * print dialog. Pages are rendered to images at the chosen resolution and
 * printed one per sheet, scaled to fit the paper.
 */
export async function printDialog(): Promise<void> {
  const { doc, pageSizes } = useDoc.getState();
  if (!doc) return;
  const n = pageSizes.length;
  const r = await openDialog({
    title: "Print",
    fields: [
      {
        kind: "radio",
        key: "pages",
        label: "Pages",
        value: "all",
        options: [
          { value: "all", label: `All pages (${n})` },
          { value: "current", label: `Current page (${useUi.getState().currentPage + 1})` },
          { value: "range", label: "Page range…" },
        ],
      },
      { kind: "text", key: "range", label: "Range", placeholder: "e.g. 1-3, 7" },
      {
        kind: "select",
        key: "quality",
        label: "Quality",
        value: "200",
        options: [
          { value: "150", label: "Draft (150 DPI)" },
          { value: "200", label: "Standard (200 DPI)" },
          { value: "300", label: "High (300 DPI)" },
        ],
      },
    ],
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Print…", variant: "primary" },
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
        : parsePageRanges(r.values.range, n);
  const dpi = parseInt(r.values.quality, 10);
  let cancelled = false;
  const urls: string[] = [];
  try {
    await withBusy(
      "Preparing pages for printing…",
      async () => {
        const { openPdf } = await import("../core/pdf/pdfjs");
        const pdf = await openPdf(await exportDocument());
        try {
          for (let k = 0; k < pages.length && !cancelled; k++) {
            setBusyLabel(`Preparing page ${k + 1} of ${pages.length} for printing…`);
            const page = await pdf.getPage(pages[k] + 1);
            const viewport = page.getViewport({ scale: dpi / 72 });
            const canvas = document.createElement("canvas");
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvas, viewport, intent: "print" }).promise;
            const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Render failed"))), "image/png"));
            urls.push(URL.createObjectURL(blob));
            canvas.width = canvas.height = 0;
          }
        } finally {
          void pdf.loadingTask.destroy();
        }
      },
      () => (cancelled = true),
    );
    if (cancelled) return;
    const root = document.createElement("div");
    root.id = "print-root";
    for (const u of urls) {
      const sheet = document.createElement("div");
      sheet.className = "print-sheet";
      const img = document.createElement("img");
      img.src = u;
      sheet.appendChild(img);
      root.appendChild(sheet);
    }
    document.body.appendChild(root);
    await Promise.all([...root.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
    const cleanup = () => {
      root.remove();
      urls.forEach((u) => URL.revokeObjectURL(u));
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
    // Some hosts do not fire afterprint; clean up eventually.
    setTimeout(cleanup, 120_000);
  } catch (e) {
    urls.forEach((u) => URL.revokeObjectURL(u));
    toast(`Printing failed: ${errorMessage(e)}`, "error");
  }
}
