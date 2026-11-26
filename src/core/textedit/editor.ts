import { loadMupdf, openMupdf, saveMupdf, rgbToHex, hexToRgb } from "../mupdf/loader";
import { name, num, parseContentStream, serializeContentStream, str, type Operation, type PdfValue } from "./contentStream";
import { codesToBytes, encodeText, loadFontInfo, type FontInfo } from "./fonts";
import { groupRuns, interpretText, mul, type Matrix, type TextBlock, type TextRun } from "./interpreter";
import type { Point, Rect } from "../annotations/types";

type MDoc = import("mupdf").PDFDocument;
type MPage = import("mupdf").PDFPage;
type PDFObject = import("mupdf").PDFObject;
/** Null-safe resolve: MuPDF's shared Null object cannot be resolved. */
const R = (o: PDFObject): PDFObject => (o.isNull() ? o : o.resolve());


export type FontFamily = "sans" | "serif" | "mono";

/** Serializable description of an editable text block, for the UI. */
export interface TextBlockInfo {
  id: string;
  text: string;
  bbox: Rect;
  /** Baseline start in PDF user space. */
  origin: Point;
  angle: number;
  size: number;
  color: string;
  fontName: string;
  family: FontFamily;
  bold: boolean;
  italic: boolean;
  editable: boolean;
  invisible: boolean;
}

export interface TextEdit {
  blockId: string;
  text: string;
  /** New size in PDF points (user space). */
  size?: number;
  color?: string;
  /** Changing the family re-typesets the text with a built-in font. */
  family?: FontFamily;
  /** Move in PDF user space. */
  dx?: number;
  dy?: number;
}

export interface EditResult {
  bytes: Uint8Array;
  mode: "in-place" | "retypeset" | "deleted";
  font: string;
}

// ---------------------------------------------------------------------------
// Page loading
// ---------------------------------------------------------------------------

interface LoadedPage {
  page: MPage;
  pageObj: PDFObject;
  ops: Operation[];
  fonts: Map<string, FontInfo>;
  runs: TextRun[];
  blocks: TextBlock[];
}

function readContents(pageObj: PDFObject): Uint8Array {
  // Note: isStream()/readStream() only work on the (unresolved) indirect reference.
  const ref = pageObj.get("Contents");
  const streams: PDFObject[] = [];
  if (ref.isStream()) streams.push(ref);
  else {
    const arr = R(ref);
    if (arr.isArray()) for (let i = 0; i < arr.length; i++) streams.push(arr.get(i));
  }
  const parts: Uint8Array[] = [];
  for (const s of streams) {
    if (!s.isStream()) continue;
    const buf = s.readStream();
    parts.push(buf.asUint8Array().slice());
    buf.destroy?.();
  }
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
    out[off++] = 0x0a; // streams are concatenated with whitespace between
  }
  return out;
}

export async function loadPage(doc: MDoc, pageIndex: number): Promise<LoadedPage> {
  const mupdf = await loadMupdf();
  const page = doc.loadPage(pageIndex) as MPage;
  const pageObj = page.getObject();
  const ops = parseContentStream(readContents(pageObj));
  const fonts = new Map<string, FontInfo>();
  const res = R(pageObj.getInheritable("Resources"));
  const fontDict = res.isDictionary() ? R(res.get("Font")) : null;
  if (fontDict?.isDictionary()) {
    // forEach hands out objects without a document reference; re-fetch by key.
    const keys: string[] = [];
    fontDict.forEach((_v, key) => keys.push(String(key)));
    for (const key of keys) {
      try {
        fonts.set(key, loadFontInfo(mupdf, key, fontDict.get(key)));
      } catch (e) {
        console.warn("font load failed", key, (e as Error)?.stack ?? e);
      }
    }
  }
  const runs = interpretText(ops, fonts);
  const blocks = groupRuns(runs);
  return { page, pageObj, ops, fonts, runs, blocks };
}

const familyOf = (f: FontInfo): FontFamily => (f.mono ? "mono" : f.serif ? "serif" : "sans");

function toInfo(b: TextBlock): TextBlockInfo {
  return {
    id: b.id,
    text: b.text,
    bbox: b.bbox,
    origin: b.runs[0].start,
    angle: b.angle,
    size: b.size,
    color: rgbToHex(b.rgb),
    fontName: b.font.baseFont.replace(/^[A-Z]{6}\+/, ""),
    family: familyOf(b.font),
    bold: b.font.bold,
    italic: b.font.italic,
    editable: b.font.editable,
    invisible: b.invisible,
  };
}

// Cache of opened documents for analysis (read-only), keyed by the bytes object.
let analysisCache: { bytes: Uint8Array; doc: MDoc } | null = null;
async function analysisDoc(bytes: Uint8Array): Promise<MDoc> {
  if (analysisCache?.bytes === bytes) return analysisCache.doc;
  analysisCache?.doc.destroy();
  const { doc } = await openMupdf(bytes);
  analysisCache = { bytes, doc };
  return doc;
}

/** Lists the text blocks of a page that can be edited. */
export async function analyzePageText(bytes: Uint8Array, pageIndex: number): Promise<TextBlockInfo[]> {
  const doc = await analysisDoc(bytes);
  const lp = await loadPage(doc, pageIndex);
  return lp.blocks.map(toInfo);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const BUILTIN: Record<FontFamily, [string, string, string, string]> = {
  sans: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
  serif: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
  mono: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};

function builtinName(family: FontFamily, bold: boolean, italic: boolean): string {
  return BUILTIN[family][(bold ? 1 : 0) + (italic ? 2 : 0)];
}

/** Adds a built-in Unicode font (embedded as a CID font) to the page resources. */
export async function addBuiltinFont(doc: MDoc, pageObj: PDFObject, fontName: string) {
  const mupdf = await loadMupdf();
  const font = new mupdf.Font(fontName);
  const ref = doc.addFont(font);
  let res = pageObj.get("Resources");
  if (res.isNull()) {
    const inherited = pageObj.getInheritable("Resources");
    res = inherited.isNull() ? doc.newDictionary() : R(inherited);
    pageObj.put("Resources", res);
  }
  res = R(res);
  let fontDict = res.get("Font");
  if (fontDict.isNull()) {
    fontDict = doc.newDictionary();
    res.put("Font", fontDict);
  }
  fontDict = R(fontDict);
  let key = "MPF1";
  for (let i = 1; !fontDict.get(key).isNull(); i++) key = `MPF${i}`;
  fontDict.put(key, ref);
  return { font, key };
}

/** Encodes text for a MuPDF-embedded CID font (codes are glyph ids). */
export function encodeForBuiltin(font: import("mupdf").Font, text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of Array.from(text)) {
    const gid = font.encodeCharacter(ch.codePointAt(0)!);
    if (gid <= 0 && ch !== " ") throw new Error(`The character “${ch}” is not available in ${font.getName()}`);
    out.push((gid >> 8) & 0xff, gid & 0xff);
  }
  return Uint8Array.from(out);
}

export function writeContents(doc: MDoc, pageObj: PDFObject, ops: Operation[]) {
  const bytes = serializeContentStream(ops);
  const stream = doc.addStream(bytes, doc.newDictionary());
  pageObj.put("Contents", stream);
}

export const op = (o: string, ...operands: PdfValue[]): Operation => ({ op: o, operands });

/** Operators that keep the line movement of a text-showing operator without drawing anything. */
function positioningOnly(run: TextRun, original: Operation): Operation[] {
  if (run.op === "'") return [op("T*")];
  if (run.op === '"') return [op("Tw", original.operands[0]), op("Tc", original.operands[1]), op("T*")];
  return [];
}

function showOp(font: FontInfo, enc: { codes: number[]; spaceGaps: number[] }): Operation {
  if (!enc.spaceGaps.length) return op("Tj", str(codesToBytes(font, enc.codes)));
  const space = font.toUnicode.size ? 278 : 250;
  const items: PdfValue[] = [];
  let from = 0;
  const gaps = [...enc.spaceGaps];
  for (const g of gaps) {
    if (g > from) items.push(str(codesToBytes(font, enc.codes.slice(from, g))));
    items.push(num(-space));
    from = g;
  }
  if (from < enc.codes.length) items.push(str(codesToBytes(font, enc.codes.slice(from))));
  return op("TJ", { t: "arr", v: items });
}

function colorOps(hex: string): Operation {
  const [r, g, b] = hexToRgb(hex);
  return op("rg", num(+r.toFixed(4)), num(+g.toFixed(4)), num(+b.toFixed(4)));
}

function restoreFill(run: TextRun): Operation {
  if (run.fill.op) return { op: run.fill.op.op, operands: run.fill.op.operands };
  return op("g", num(0));
}

/**
 * Edits one text block. Prefers rewriting the original text operators in the
 * original font (true in-place edit); falls back to removing the original
 * glyphs and typesetting the new text as page content at the same position
 * when the font cannot represent the new text, another family is requested,
 * or the text is moved.
 */
export async function applyTextEdit(bytes: Uint8Array, pageIndex: number, edit: TextEdit): Promise<EditResult> {
  const { doc } = await openMupdf(bytes);
  try {
    const lp = await loadPage(doc, pageIndex);
    const block = lp.blocks.find((b) => b.id === edit.blockId);
    if (!block) throw new Error("The text has changed since it was selected. Please try again.");
    const first = block.runs[0];
    const font = block.font;
    if (!font.editable) throw new Error(`Text in the font “${font.baseFont}” cannot be decoded for editing.`);

    const newText = edit.text.replace(/[\r\n]+/g, " ");
    const sizeScale = edit.size && Math.abs(edit.size - block.size) > 0.01 ? edit.size / block.size : 1;
    const colorChanged = !!edit.color && edit.color.toLowerCase() !== rgbToHex(block.rgb).toLowerCase();
    const moved = Math.abs(edit.dx ?? 0) > 0.01 || Math.abs(edit.dy ?? 0) > 0.01;
    const familyChanged = !!edit.family && edit.family !== familyOf(font);

    // Replacement operator lists, keyed by the index of the operator they replace.
    const replace = new Map<number, Operation[]>();
    // 1) Remove the original text operators (keeping their line movement).
    for (const r of block.runs) replace.set(r.opIndex, positioningOnly(r, lp.ops[r.opIndex]));
    const finish = () => lp.ops.flatMap((o, i) => replace.get(i) ?? [o]);

    if (!newText.trim()) {
      writeContents(doc, lp.pageObj, finish());
      return { bytes: saveMupdf(doc, "compress"), mode: "deleted", font: font.baseFont };
    }

    const enc = familyChanged ? null : encodeText(font, newText);

    if (enc && !moved) {
      // 2a) In place: the first operator now shows the whole new text in the original font.
      const group: Operation[] = [...positioningOnly(first, lp.ops[first.opIndex])];
      if (sizeScale !== 1) group.push(op("Tf", name(font.key), num(+(first.fontSize * sizeScale).toFixed(3))));
      if (colorChanged) group.push(colorOps(edit.color!));
      group.push(showOp(font, enc));
      if (colorChanged) group.push(restoreFill(first));
      if (sizeScale !== 1) group.push(op("Tf", name(font.key), num(first.fontSize)));
      replace.set(first.opIndex, group);
      writeContents(doc, lp.pageObj, finish());
      return { bytes: saveMupdf(doc, "compress"), mode: "in-place", font: font.baseFont.replace(/^[A-Z]{6}\+/, "") };
    }

    // 2b) Re-typeset as a new text object at the original (or moved) position.
    let fontKey = font.key;
    let textValue: PdfValue | Operation;
    let usedFont = font.baseFont.replace(/^[A-Z]{6}\+/, "");
    if (enc) {
      textValue = showOp(font, enc);
    } else {
      const fam = edit.family ?? familyOf(font);
      const added = await addBuiltinFont(doc, lp.pageObj, builtinName(fam, font.bold, font.italic));
      fontKey = added.key;
      usedFont = added.font.getName();
      textValue = op("Tj", str(encodeForBuiltin(added.font, newText)));
    }
    const ctm: Matrix = moved ? mul(first.ctm, [1, 0, 0, 1, edit.dx ?? 0, edit.dy ?? 0]) : first.ctm;
    const tfSize = +(first.fontSize * sizeScale).toFixed(3);
    const block2: Operation[] = [
      op("q"),
      op("cm", ...ctm.map((v) => num(+v.toFixed(6)))),
      op("BT"),
      op("Tf", name(fontKey), num(tfSize)),
      colorChanged ? colorOps(edit.color!) : restoreFill(first),
      op("Tr", num(first.renderMode === 7 ? 3 : first.renderMode)),
      op("Tz", num(+(first.hScale * 100).toFixed(3))),
      op("Tc", num(0)),
      op("Tw", num(0)),
      op("Ts", num(first.rise)),
      op("Tm", ...first.tm.map((v) => num(+v.toFixed(6)))),
      textValue as Operation,
      op("ET"),
      op("Q"),
    ];
    // Isolate the original content's graphics state from the new text object.
    const all = [op("q"), ...finish(), op("Q"), ...block2];
    writeContents(doc, lp.pageObj, all);
    return { bytes: saveMupdf(doc, "compress"), mode: "retypeset", font: usedFont };
  } finally {
    doc.destroy();
  }
}

export interface InsertTextOptions {
  /** Baseline start in PDF user space. */
  origin: Point;
  /** Unit vectors in user space for the text direction and "up" (handles page rotation). */
  dir: Point;
  up: Point;
  text: string;
  size: number;
  color: string;
  family: FontFamily;
  bold?: boolean;
  italic?: boolean;
}

/** Adds new text to the page as real page content (multi-line supported). */
export async function insertText(bytes: Uint8Array, pageIndex: number, o: InsertTextOptions): Promise<{ bytes: Uint8Array; font: string }> {
  const { doc } = await openMupdf(bytes);
  try {
    const lp = await loadPage(doc, pageIndex);
    const added = await addBuiltinFont(doc, lp.pageObj, builtinName(o.family, !!o.bold, !!o.italic));
    const lines = o.text.replace(/\r/g, "").split("\n");
    const lead = o.size * 1.25;
    const textOps: Operation[] = [
      op("q"),
      op("BT"),
      op("Tf", name(added.key), num(o.size)),
      colorOps(o.color),
      op("Tm", num(o.dir[0]), num(o.dir[1]), num(o.up[0]), num(o.up[1]), num(+o.origin[0].toFixed(3)), num(+o.origin[1].toFixed(3))),
    ];
    lines.forEach((line, i) => {
      if (i > 0) textOps.push(op("Td", num(0), num(-lead)));
      if (line) textOps.push(op("Tj", str(encodeForBuiltin(added.font, line))));
    });
    textOps.push(op("ET"), op("Q"));
    writeContents(doc, lp.pageObj, [op("q"), ...lp.ops, op("Q"), ...textOps]);
    return { bytes: saveMupdf(doc, "compress"), font: added.font.getName() };
  } finally {
    doc.destroy();
  }
}
