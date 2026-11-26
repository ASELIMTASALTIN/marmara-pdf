import { openMupdf, saveMupdf } from "../mupdf/loader";

/** Field values keyed by fully-qualified field name. Checkboxes: boolean; radios/choices/text: string. */
export type FormValues = Record<string, string | boolean>;

type PDFObject = import("mupdf").PDFObject;

/** The "on" state name of a checkbox/radio widget (its /AP /N key other than Off). */
function onStateName(widgetObj: PDFObject): string | null {
  const ap = widgetObj.get("AP");
  if (ap.isNull()) return null;
  const n = ap.resolve().get("N");
  if (n.isNull()) return null;
  const dict = n.resolve();
  if (!dict.isDictionary()) return null;
  let on: string | null = null;
  dict.forEach((_v, k) => {
    if (String(k) !== "Off") on = String(k);
  });
  return on;
}

/** True when the field's raw /DA requests automatic font size ("0 Tf"). */
function isAutoSize(widgetObj: PDFObject): boolean {
  let o: PDFObject | null = widgetObj;
  for (let depth = 0; o && depth < 5; depth++) {
    const da = o.get("DA");
    if (!da.isNull()) return /(^|\s)0(\.0*)?\s+Tf/.test(da.resolve().asString());
    const parent = o.get("Parent");
    o = parent.isNull() ? null : parent.resolve();
  }
  return true;
}

/** The /Opt label of a radio widget (field /Opt indexed by the widget's position in /Kids). */
function optLabel(widgetObj: PDFObject): string | null {
  try {
    const parentRef = widgetObj.get("Parent");
    if (parentRef.isNull()) return null;
    const parent = parentRef.resolve();
    const opt = parent.get("Opt");
    const kids = parent.get("Kids");
    if (opt.isNull() || kids.isNull()) return null;
    const optArr = opt.resolve();
    const kidsArr = kids.resolve();
    const me = widgetObj.isIndirect() ? widgetObj.asIndirect() : -1;
    for (let i = 0; i < kidsArr.length; i++) {
      const k = kidsArr.get(i);
      if (k.isIndirect() && k.asIndirect() === me) {
        const o = optArr.get(i);
        return o.isNull() ? null : o.resolve().asString();
      }
    }
  } catch {
    /* malformed field: ignore */
  }
  return null;
}

/**
 * Writes form values into the PDF's AcroForm fields. MuPDF regenerates the
 * widget appearance streams so the values display in every PDF reader.
 */
export async function applyFormValues(bytes: Uint8Array, values: FormValues): Promise<Uint8Array> {
  const names = Object.keys(values);
  if (!names.length) return bytes;
  const { doc } = await openMupdf(bytes);
  try {
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i) as import("mupdf").PDFPage;
      let changed = false;
      for (const w of page.getWidgets()) {
        const name = w.getName();
        if (!(name in values) || w.isReadOnly()) continue;
        const v = values[name];
        if (w.isText()) {
          if (w.getValue() !== String(v)) {
            // Auto-sized (0 pt) multi-line fields would render as one huge line: use 11 pt.
            const da = w.getDefaultAppearance();
            const r = w.getRect();
            const fieldH = Math.abs(r[3] - r[1]);
            // Auto-sized, or so large that not even two lines fit: use a readable 11 pt.
            if (w.isMultiline() && (isAutoSize(w.getObject()) || da.size * 2.2 > fieldH)) {
              w.setDefaultAppearance(da.font || "Helv", 11, da.color?.length ? da.color : [0]);
            }
            w.setTextValue(String(v));
            changed = true;
          }
        } else if (w.isChoice()) {
          if (w.getValue() !== String(v)) {
            w.setChoiceValue(String(v));
            changed = true;
          }
        } else if (w.isCheckbox()) {
          const want = v === true || (typeof v === "string" && v !== "Off" && v !== "");
          const cur = w.getValue() !== "Off" && w.getValue() !== "";
          if (want !== cur) {
            w.toggle();
            changed = true;
          }
        } else if (w.isRadioButton()) {
          const obj = w.getObject();
          const on = onStateName(obj);
          const matches = on !== null && (on === v || optLabel(obj) === v);
          if (on && matches && w.getValue() !== on) {
            w.toggle();
            changed = true;
          }
        } else continue;
        w.update();
      }
      if (changed) page.update();
    }
    return saveMupdf(doc, "compress");
  } finally {
    doc.destroy();
  }
}
