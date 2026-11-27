import { commit, exclusive, useDoc, withBusy } from "../state/documentStore";
import { errorMessage, openDialog, toast, type DialogField } from "../state/dialogStore";
import { parsePageRanges } from "../core/pdf/pageOps";
import type { StampOptions } from "../core/stamp/stamp";

const pagesField: DialogField = { kind: "text", key: "pages", label: "Pages (empty = all)", placeholder: "e.g. 2-10" };
const TOKENS_HINT = "Tokens: {page} {pages} {date} {file} {bates}";

function pageList(expr: string, n: number): number[] {
  return expr.trim() ? [...new Set(parsePageRanges(expr, n))] : Array.from({ length: n }, (_, i) => i);
}

function validatePages(v: Record<string, string>, n: number): string | null {
  if (!v.pages?.trim()) return null;
  try {
    parsePageRanges(v.pages, n);
    return null;
  } catch (e) {
    return errorMessage(e);
  }
}

async function apply(label: string, build: (pages: number[], fileName: string) => StampOptions, expr: string) {
  await exclusive(async () => {
    const { doc, pageSizes } = useDoc.getState();
    if (!doc) return;
    try {
      const { stampPages } = await import("../core/stamp/stamp");
      const opts = build(pageList(expr, pageSizes.length), doc.name);
      const bytes = await withBusy(`${label}…`, () => stampPages(doc.bytes, opts));
      await commit(label, { bytes });
      toast(`${label}: done on ${opts.pages.length} page${opts.pages.length > 1 ? "s" : ""}`, "success");
    } catch (e) {
      toast(`${label} failed: ${errorMessage(e)}`, "error");
    }
  });
}

export async function headerFooterDialog() {
  const n = useDoc.getState().pageSizes.length;
  const r = await openDialog({
    title: "Header, footer & page numbers",
    message: `${TOKENS_HINT}. Re-applying replaces earlier headers, footers and watermarks on the same pages.`,
    fields: [
      { kind: "text", key: "hl", label: "Header left" },
      { kind: "text", key: "hc", label: "Header centre" },
      { kind: "text", key: "hr", label: "Header right" },
      { kind: "text", key: "fl", label: "Footer left" },
      { kind: "text", key: "fc", label: "Footer centre", value: "Sayfa {page} / {pages}" },
      { kind: "text", key: "fr", label: "Footer right" },
      { kind: "number", key: "size", label: "Font size", value: 9, min: 5, max: 36 },
      { kind: "number", key: "start", label: "First page number", value: 1, min: 0, max: 99999 },
      pagesField,
    ],
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Apply", variant: "primary" },
    ],
    validate: (v, b) => (b === "ok" ? validatePages(v, n) : null),
    width: 520,
  });
  if (r.button !== "ok") return;
  const v = r.values;
  await apply(
    "Header & footer",
    (pages, fileName) => ({
      pages,
      fileName,
      header: { left: v.hl, center: v.hc, right: v.hr },
      footer: { left: v.fl, center: v.fc, right: v.fr },
      fontSize: +v.size || 9,
      startNumber: +v.start || 1,
    }),
    v.pages,
  );
}

export async function watermarkDialog() {
  const n = useDoc.getState().pageSizes.length;
  const r = await openDialog({
    title: "Watermark",
    fields: [
      { kind: "text", key: "text", label: "Text", value: "TASLAK" },
      { kind: "number", key: "size", label: "Font size", value: 72, min: 8, max: 400 },
      {
        kind: "select",
        key: "color",
        label: "Colour",
        value: "#d1242f",
        options: [
          { value: "#d1242f", label: "Red" },
          { value: "#1f2328", label: "Black" },
          { value: "#7a8494", label: "Grey" },
          { value: "#1366c4", label: "Blue" },
          { value: "#1a7f37", label: "Green" },
        ],
      },
      { kind: "number", key: "opacity", label: "Opacity (%)", value: 20, min: 5, max: 100 },
      { kind: "number", key: "rotation", label: "Rotation (degrees)", value: 45, min: -90, max: 90 },
      pagesField,
    ],
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Apply", variant: "primary" },
    ],
    validate: (v, b) => (b === "ok" ? (!v.text.trim() ? "Enter the watermark text." : validatePages(v, n)) : null),
  });
  if (r.button !== "ok") return;
  const v = r.values;
  await apply(
    "Watermark",
    (pages, fileName) => ({
      pages,
      fileName,
      watermark: { text: v.text, size: +v.size || 72, color: v.color, opacity: Math.min(1, Math.max(0.05, (+v.opacity || 20) / 100)), rotation: +v.rotation || 0 },
    }),
    v.pages,
  );
}

export async function batesDialog() {
  const n = useDoc.getState().pageSizes.length;
  const r = await openDialog({
    title: "Bates numbering",
    message: "Adds a unique, sequential identifier to every page (legal and archival use).",
    fields: [
      { kind: "text", key: "prefix", label: "Prefix", value: "MRM" },
      { kind: "number", key: "start", label: "Start number", value: 1, min: 0, max: 99999999 },
      { kind: "number", key: "digits", label: "Digits", value: 6, min: 1, max: 12 },
      { kind: "text", key: "suffix", label: "Suffix" },
      {
        kind: "select",
        key: "pos",
        label: "Position",
        value: "fr",
        options: [
          { value: "fr", label: "Bottom right" },
          { value: "fc", label: "Bottom centre" },
          { value: "fl", label: "Bottom left" },
          { value: "hr", label: "Top right" },
        ],
      },
      pagesField,
    ],
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Apply", variant: "primary" },
    ],
    validate: (v, b) => (b === "ok" ? validatePages(v, n) : null),
  });
  if (r.button !== "ok") return;
  const v = r.values;
  const slot = { [v.pos.slice(1) === "r" ? "right" : v.pos.slice(1) === "c" ? "center" : "left"]: "{bates}" };
  await apply(
    "Bates numbering",
    (pages, fileName) => ({
      pages,
      fileName,
      ...(v.pos.startsWith("h") ? { header: slot } : { footer: slot }),
      fontSize: 9,
      bates: { prefix: v.prefix, start: +v.start || 0, digits: +v.digits || 6, suffix: v.suffix },
    }),
    v.pages,
  );
}

export async function removeStampsAction() {
  await exclusive(async () => {
    const { doc } = useDoc.getState();
    if (!doc) return;
    try {
      const { removeStamps } = await import("../core/stamp/stamp");
      const r = await withBusy("Removing…", () => removeStamps(doc.bytes));
      if (!r.pages) {
        toast("No headers, footers or watermarks added by Marmara PDF were found.", "info");
        return;
      }
      await commit("Remove headers, footers & watermarks", { bytes: r.bytes });
      toast(`Removed from ${r.pages} page${r.pages > 1 ? "s" : ""}`, "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  });
}
