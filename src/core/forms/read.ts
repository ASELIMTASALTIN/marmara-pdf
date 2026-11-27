import { openMupdf } from "../mupdf/loader";

type PDFObject = import("mupdf").PDFObject;

function onState(obj: PDFObject): string | null {
  const ap = obj.get("AP");
  if (ap.isNull()) return null;
  const n = ap.resolve().get("N");
  if (n.isNull() || !n.resolve().isDictionary()) return null;
  let on: string | null = null;
  n.resolve().forEach((_v, k) => {
    if (String(k) !== "Off") on = String(k);
  });
  return on;
}

export interface FieldInfo {
  name: string;
  type: string;
  value: string | boolean;
  options?: string[];
  pages: number[];
  rects: number[][];
  required?: boolean;
  read_only?: boolean;
  multiline?: boolean;
}

/** Lists the form fields with type, value, choices, pages and widget rectangles (display coordinates). */
export async function readFields(bytes: Uint8Array): Promise<FieldInfo[]> {
  const { mupdf, doc } = await openMupdf(bytes);
  try {
    const byName = new Map<string, FieldInfo>();
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i) as import("mupdf").PDFPage;
      for (const w of page.getWidgets()) {
        const name = w.getName();
        const type = w.isCheckbox() ? "checkbox" : w.isRadioButton() ? "radio" : w.isComboBox() ? "dropdown" : w.isListBox() ? "list" : w.isText() ? "text" : w.getFieldType();
        const r = w.getRect().map((v) => Math.round(v * 100) / 100);
        const raw = w.getValue();
        let f = byName.get(name);
        if (!f) {
          f = {
            name,
            type,
            value: type === "checkbox" ? raw !== "Off" && raw !== "" : type === "radio" ? (raw === "Off" ? "" : raw) : raw,
            pages: [],
            rects: [],
            required: (w.getFieldFlags() & mupdf.PDFWidget.FIELD_IS_REQUIRED) !== 0 || undefined,
            read_only: w.isReadOnly() || undefined,
            multiline: (w.isText() && w.isMultiline()) || undefined,
          };
          if (w.isChoice()) f.options = w.getOptions();
          byName.set(name, f);
        }
        if (type === "radio") {
          const on = onState(w.getObject());
          if (on) f.options = [...new Set([...(f.options ?? []), on])];
          if (raw && raw !== "Off") f.value = raw;
        }
        if (!f.pages.includes(i + 1)) f.pages.push(i + 1);
        f.rects.push(r);
      }
    }
    return [...byName.values()];
  } finally {
    doc.destroy();
  }
}
