import forge from "node-forge";
import { loadMupdf, openMupdf, saveMupdf } from "../mupdf/loader";
import type { Rect } from "../annotations/types";
import { certField, type UnlockedId } from "./identity";
import { buildCms } from "./cms";

/**
 * PDF digital signatures (PAdES-compatible, SubFilter ETSI.CAdES.detached).
 *
 * The signature field, widget and appearance are added with MuPDF and written
 * as an *incremental update*, so previously applied signatures stay valid.
 * The /Contents placeholder is then filled with a detached CMS signature over
 * the /ByteRange (everything except the placeholder itself).
 */

const PLACEHOLDER_BYTES = 12288; // room for certificate chains
// MuPDF writes integers > 2^31 through a float, so keep the placeholders 9 digits long.
const BR_VALUE = 999999999;

type PDFObject = import("mupdf").PDFObject;
type MDoc = import("mupdf").PDFDocument;

export interface SignOptions {
  pageIndex: number;
  /** Widget rectangle in PDF user space; null for an invisible signature. */
  rect: Rect | null;
  reason?: string;
  location?: string;
  contact?: string;
  /** Optional handwritten signature image (PNG/JPEG) shown in the appearance. */
  image?: Uint8Array;
  /** Signing time (defaults to now). */
  date?: Date;
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p(Math.floor(Math.abs(off) / 60));
  const om = p(Math.abs(off) % 60);
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${oh}'${om}'`;
}

function nameObj(doc: MDoc, n: string) {
  return doc.newName(n);
}

/** Builds the visible appearance: optional image on the left, signer details on the right. */
async function buildAppearance(doc: MDoc, w: number, h: number, lines: string[], image?: Uint8Array): Promise<PDFObject> {
  const mupdf = await loadMupdf();
  const font = new mupdf.Font("Helvetica");
  const fontRef = doc.addFont(font);
  const resources = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", fontRef);
  resources.put("Font", fonts);

  let content = "q\n";
  let textX = 4;
  if (image) {
    const img = new mupdf.Image(image);
    const imgRef = doc.addImage(img);
    const xo = doc.newDictionary();
    xo.put("Im1", imgRef);
    resources.put("XObject", xo);
    const iw = img.getWidth();
    const ih = img.getHeight();
    const boxW = w * 0.45;
    const s = Math.min(boxW / iw, (h - 4) / ih);
    const dw = iw * s;
    const dh = ih * s;
    content += `q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${(2 + (boxW - dw) / 2).toFixed(2)} ${((h - dh) / 2).toFixed(2)} cm /Im1 Do Q\n`;
    textX = boxW + 6;
  }
  const avail = w - textX - 3;
  // Fit the text block: font size from the box height and the longest line.
  const width = (t: string, size: number) =>
    Array.from(t).reduce((a, ch) => a + font.advanceGlyph(Math.max(0, font.encodeCharacter(ch.codePointAt(0)!))) * size, 0);
  let size = Math.min(10, (h - 4) / (lines.length * 1.2));
  while (size > 4 && Math.max(...lines.map((l) => width(l, size))) > avail) size -= 0.25;
  const hex = (t: string) =>
    Array.from(t)
      .map((ch) => Math.max(0, font.encodeCharacter(ch.codePointAt(0)!)).toString(16).padStart(4, "0"))
      .join("");
  const lead = size * 1.2;
  const top = h / 2 + (lines.length * lead) / 2 - size;
  content += `BT /F1 ${size.toFixed(2)} Tf 0.1 0.15 0.3 rg ${textX.toFixed(2)} ${top.toFixed(2)} Td\n`;
  lines.forEach((l, i) => {
    if (i) content += `0 ${(-lead).toFixed(2)} Td\n`;
    content += `<${hex(l)}> Tj\n`;
  });
  content += "ET\nQ\n";

  const dict = doc.newDictionary();
  dict.put("Type", nameObj(doc, "XObject"));
  dict.put("Subtype", nameObj(doc, "Form"));
  const bbox = doc.newArray();
  [0, 0, w, h].forEach((v) => bbox.push(v));
  dict.put("BBox", bbox);
  dict.put("Resources", resources);
  return doc.addStream(new TextEncoder().encode(content), dict);
}

function sha256(data: Uint8Array): forge.util.ByteStringBuffer {
  const md = forge.md.sha256.create();
  for (let i = 0; i < data.length; i += 0x10000) md.update(String.fromCharCode(...data.subarray(i, i + 0x10000)));
  return md.digest();
}

/** Signs a PDF and returns the signed file. */
export async function signPdf(bytes: Uint8Array, id: UnlockedId, o: SignOptions): Promise<Uint8Array> {
  const { doc } = await openMupdf(bytes);
  let prepared: Uint8Array;
  const date = o.date ?? new Date();
  try {
    const page = doc.loadPage(o.pageIndex) as import("mupdf").PDFPage;
    const pageObj = page.getObject();
    const signerName = certField(id.cert, "subject", "CN") ?? certField(id.cert, "subject", "O") ?? "Signer";

    // --- signature dictionary with placeholders ---
    const sig = doc.newDictionary();
    sig.put("Type", nameObj(doc, "Sig"));
    sig.put("Filter", nameObj(doc, "Adobe.PPKLite"));
    sig.put("SubFilter", nameObj(doc, "ETSI.CAdES.detached"));
    const br = doc.newArray();
    [0, BR_VALUE, BR_VALUE, BR_VALUE].forEach((v) => br.push(v));
    sig.put("ByteRange", br);
    sig.put("Contents", doc.newByteString(new Uint8Array(PLACEHOLDER_BYTES)));
    sig.put("M", doc.newString(pdfDate(date)));
    sig.put("Name", doc.newString(signerName));
    if (o.reason) sig.put("Reason", doc.newString(o.reason));
    if (o.location) sig.put("Location", doc.newString(o.location));
    if (o.contact) sig.put("ContactInfo", doc.newString(o.contact));
    const sigRef = doc.addObject(sig);

    // --- field / widget ---
    const acroForm = (() => {
      const root = doc.getTrailer().get("Root").resolve();
      let af = root.get("AcroForm");
      if (af.isNull()) {
        af = doc.addObject(doc.newDictionary());
        root.put("AcroForm", af);
      }
      return af.resolve();
    })();
    let fields = acroForm.get("Fields");
    if (fields.isNull()) {
      fields = doc.newArray();
      acroForm.put("Fields", fields);
    }
    fields = fields.resolve();
    acroForm.put("SigFlags", 3);
    let n = 1;
    const existing = new Set<string>();
    for (let i = 0; i < fields.length; i++) {
      const t = fields.get(i).resolve().get("T");
      if (t.isString()) existing.add(t.asString());
    }
    while (existing.has(`Signature${n}`)) n++;

    const widget = doc.newDictionary();
    widget.put("Type", nameObj(doc, "Annot"));
    widget.put("Subtype", nameObj(doc, "Widget"));
    widget.put("FT", nameObj(doc, "Sig"));
    widget.put("T", doc.newString(`Signature${n}`));
    widget.put("F", 132); // Print + Locked
    widget.put("P", pageObj);
    widget.put("V", sigRef);
    const rect = o.rect ?? [0, 0, 0, 0];
    const ra = doc.newArray();
    rect.forEach((v) => ra.push(+v.toFixed(3)));
    widget.put("Rect", ra);
    if (o.rect) {
      const w = Math.abs(rect[2] - rect[0]);
      const h = Math.abs(rect[3] - rect[1]);
      const lines = [
        `Digitally signed by ${signerName}`,
        `Date: ${date.toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" })}`,
        ...(o.reason ? [`Reason: ${o.reason}`] : []),
        ...(o.location ? [`Location: ${o.location}`] : []),
      ];
      const ap = doc.newDictionary();
      ap.put("N", await buildAppearance(doc, w, h, lines, o.image));
      widget.put("AP", ap);
    }
    const widgetRef = doc.addObject(widget);
    fields.push(widgetRef);
    let annots = pageObj.get("Annots");
    if (annots.isNull()) {
      annots = doc.newArray();
      pageObj.put("Annots", annots);
    }
    annots.resolve().push(widgetRef);

    // Incremental update keeps earlier revisions (and their signatures) byte-identical.
    prepared = doc.canBeSavedIncrementally() ? concat(bytes, saveIncrementalTail(doc, bytes)) : saveMupdf(doc, "");
  } finally {
    doc.destroy();
  }

  // --- fill in ByteRange and Contents (search only the appended update) ---
  const tailFrom = Math.max(0, bytes.length - 16);
  const tail = new TextDecoder("latin1").decode(prepared.subarray(tailFrom));
  const contentsRe = new RegExp(String.raw`/Contents\s*<(0{${PLACEHOLDER_BYTES * 2}})>`, "g");
  let cm: RegExpExecArray | null = null;
  for (let m: RegExpExecArray | null; (m = contentsRe.exec(tail)); ) cm = m;
  if (!cm) throw new Error("Internal error: signature placeholder not found");
  const start = tailFrom + cm.index + cm[0].indexOf("<"); // at '<'
  const end = start + PLACEHOLDER_BYTES * 2 + 2; // after '>'
  const brRe = new RegExp(String.raw`/ByteRange\s*\[\s*0\s+${BR_VALUE}\s+${BR_VALUE}\s+${BR_VALUE}\s*\]`, "g");
  let bm: RegExpExecArray | null = null;
  for (let m: RegExpExecArray | null; (m = brRe.exec(tail)); ) bm = m;
  if (!bm) throw new Error("Internal error: byte range placeholder not found");
  const range = [0, start, end, prepared.length - end];
  const brText = `/ByteRange[${range.join(" ")}]`;
  if (brText.length > bm[0].length) throw new Error("Internal error: byte range does not fit");
  prepared.set(new TextEncoder().encode(brText.padEnd(bm[0].length, " ")), tailFrom + bm.index);

  const signed = new Uint8Array(prepared.length - (end - start));
  signed.set(prepared.subarray(0, start), 0);
  signed.set(prepared.subarray(end), start);
  const digest = sha256(signed);

  const cms = buildCms(digest.getBytes(), id.key, id.cert, id.chain, date);
  const hex = forge.util.bytesToHex(String.fromCharCode(...cms));
  if (hex.length > PLACEHOLDER_BYTES * 2) throw new Error("The signature is too large for the reserved space.");
  prepared.set(new TextEncoder().encode(hex.padEnd(PLACEHOLDER_BYTES * 2, "0")), start + 1);
  return prepared;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** MuPDF's incremental save returns the whole file; keep only the appended update. */
function saveIncrementalTail(doc: MDoc, original: Uint8Array): Uint8Array {
  const full = saveMupdf(doc, "incremental");
  for (let i = 0; i < original.length; i += 4096) {
    const n = Math.min(4096, original.length - i);
    for (let k = 0; k < n; k++) if (full[i + k] !== original[i + k]) throw new Error("Incremental save changed earlier bytes");
  }
  return full.subarray(original.length);
}
