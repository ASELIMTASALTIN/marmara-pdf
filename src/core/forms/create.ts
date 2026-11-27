import { PDFDocument, PDFName, PDFRadioGroup, StandardFonts } from "pdf-lib";
import type { Rect } from "../annotations/types";
import { openMupdf, saveMupdf } from "../mupdf/loader";
import { loadEditable, saveDoc } from "../pdf/pageOps";

export type FieldKind = "text" | "multiline" | "checkbox" | "radio" | "dropdown" | "signature";

export interface NewField {
  kind: FieldKind;
  name: string;
  pageIndex: number;
  /** PDF user-space rectangle. */
  rect: Rect;
  /** Dropdown choices, or the radio button's value. */
  options?: string[];
  required?: boolean;
  fontSize?: number;
}

/** Names of existing form fields. */
export async function fieldNames(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getForm().getFields().map((f) => f.getName());
}

async function addSignatureField(bytes: Uint8Array, f: NewField): Promise<Uint8Array> {
  const { doc } = await openMupdf(bytes);
  try {
    const page = (doc.loadPage(f.pageIndex) as import("mupdf").PDFPage).getObject();
    const root = doc.getTrailer().get("Root").resolve();
    let af = root.get("AcroForm");
    if (af.isNull()) {
      af = doc.addObject(doc.newDictionary());
      root.put("AcroForm", af);
    }
    const acro = af.resolve();
    let fields = acro.get("Fields");
    if (fields.isNull()) {
      fields = doc.newArray();
      acro.put("Fields", fields);
    }
    const w = doc.newDictionary();
    w.put("Type", doc.newName("Annot"));
    w.put("Subtype", doc.newName("Widget"));
    w.put("FT", doc.newName("Sig"));
    w.put("T", doc.newString(f.name));
    w.put("F", 4);
    w.put("P", page);
    const r = doc.newArray();
    f.rect.forEach((v) => r.push(+v.toFixed(2)));
    w.put("Rect", r);
    const mk = doc.newDictionary();
    const bc = doc.newArray();
    [0.4, 0.4, 0.4].forEach((v) => bc.push(v));
    mk.put("BC", bc);
    w.put("MK", mk);
    const ref = doc.addObject(w);
    fields.resolve().push(ref);
    let annots = page.get("Annots");
    if (annots.isNull()) {
      annots = doc.newArray();
      page.put("Annots", annots);
    }
    annots.resolve().push(ref);
    return saveMupdf(doc, "compress");
  } finally {
    doc.destroy();
  }
}

/** Adds an interactive form field to a page. */
export async function addFormField(bytes: Uint8Array, f: NewField): Promise<Uint8Array> {
  if (f.kind === "signature") return addSignatureField(bytes, f);
  const doc = await loadEditable(bytes);
  const form = doc.getForm();
  const page = doc.getPage(f.pageIndex);
  const [x0, y0, x1, y1] = f.rect;
  const box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, borderWidth: 1 };
  const font = await doc.embedFont(StandardFonts.Helvetica);
  switch (f.kind) {
    case "text":
    case "multiline": {
      const t = form.createTextField(f.name);
      if (f.kind === "multiline") t.enableMultiline();
      t.addToPage(page, { ...box, font });
      t.setFontSize(f.fontSize ?? 0);
      if (f.required) t.enableRequired();
      break;
    }
    case "checkbox": {
      const c = form.createCheckBox(f.name);
      c.addToPage(page, box);
      if (f.required) c.enableRequired();
      break;
    }
    case "radio": {
      const value = f.options?.[0] || "Option";
      const existing = form.getFields().find((x) => x.getName() === f.name);
      const g = existing instanceof PDFRadioGroup ? existing : form.createRadioGroup(f.name);
      g.addOptionToPage(value, page, box);
      if (f.required) g.enableRequired();
      break;
    }
    case "dropdown": {
      const d = form.createDropdown(f.name);
      d.addOptions(f.options?.length ? f.options : ["Option 1"]);
      d.addToPage(page, { ...box, font });
      if (f.required) d.enableRequired();
      break;
    }
  }
  // Let viewers regenerate appearances where needed.
  form.acroForm.dict.set(PDFName.of("NeedAppearances"), doc.context.obj(true));
  return saveDoc(doc);
}

/** Removes a form field (all its widgets). */
export function removeFormField(bytes: Uint8Array, name: string): Promise<Uint8Array> {
  return removeWithMupdf(bytes, name);
}

async function removeWithMupdf(bytes: Uint8Array, name: string): Promise<Uint8Array> {
  const { doc } = await openMupdf(bytes);
  try {
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i) as import("mupdf").PDFPage;
      for (const w of [...page.getWidgets()]) if (w.getName() === name) page.deleteAnnotation(w);
      page.update();
    }
    const acro = doc.getTrailer().get("Root").resolve().get("AcroForm");
    if (!acro.isNull()) {
      const fields = acro.resolve().get("Fields");
      if (!fields.isNull()) {
        const arr = fields.resolve();
        for (let k = arr.length - 1; k >= 0; k--) {
          const t = arr.get(k).resolve().get("T");
          if (t.isString() && t.asString() === name) arr.delete(k);
        }
      }
    }
    return saveMupdf(doc, "compress");
  } finally {
    doc.destroy();
  }
}
