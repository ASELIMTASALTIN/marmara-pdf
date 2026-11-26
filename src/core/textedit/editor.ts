import { loadMupdf, openMupdf, saveMupdf, rgbToHex, hexToRgb } from "../mupdf/loader";
import { name, num, parseContentStream, serializeContentStream, str, type Operation, type PdfValue } from "./contentStream";
import { codesToBytes, encodeText, loadFontInfo, type FontInfo } from "./fonts";
import {
  apply,
  groupParagraphs,
  groupRuns,
  interpretText,
  mul,
  IDENTITY,
  type FormXObject,
  type Matrix,
  type Paragraph,
  type StreamSource,
  type TextBlock,
  type TextRun,
  type XObjectResolver,
} from "./interpreter";
import type { Point, Rect } from "../annotations/types";

type MDoc = import("mupdf").PDFDocument;
type MPage = import("mupdf").PDFPage;
type PDFObject = import("mupdf").PDFObject;
type MuPDF = typeof import("mupdf");
/** Null-safe resolve: MuPDF's shared Null object cannot be resolved. */
const R = (o: PDFObject): PDFObject => (o.isNull() ? o : o.resolve());

export type FontFamily = "sans" | "serif" | "mono";

/** Serializable description of an editable text block (a paragraph), for the UI. */
export interface TextBlockInfo {
  id: string;
  text: string;
  bbox: Rect;
  /** Baseline start of the first line in PDF user space. */
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
  /** Number of lines; > 1 means edits re-flow the paragraph. */
  lines: number;
  /** Paragraph width along the baseline (user units). */
  width: number;
  /** Distance between baselines (user units, 0 for one line). */
  leading: number;
  /** True when the text lives in a form XObject (e.g. a header stamp). */
  inXObject: boolean;
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
  mode: "in-place" | "retypeset" | "reflowed" | "deleted";
  font: string;
  /** True when a built-in font replaced the original one (missing glyphs or family change). */
  substituted: boolean;
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
  lines: TextBlock[];
  paragraphs: Paragraph[];
}

function readStreams(streams: PDFObject[]): Uint8Array {
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

function readContents(pageObj: PDFObject): Uint8Array {
  // Note: isStream()/readStream() only work on the (unresolved) indirect reference.
  const ref = pageObj.get("Contents");
  const streams: PDFObject[] = [];
  if (ref.isStream()) streams.push(ref);
  else {
    const arr = R(ref);
    if (arr.isArray()) for (let i = 0; i < arr.length; i++) streams.push(arr.get(i));
  }
  return readStreams(streams);
}

function loadFonts(mupdf: MuPDF, resources: PDFObject): Map<string, FontInfo> {
  const fonts = new Map<string, FontInfo>();
  const fontDict = resources.isDictionary() ? R(resources.get("Font")) : null;
  if (!fontDict?.isDictionary()) return fonts;
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
  return fonts;
}

const numOf = (o: PDFObject, d = 0) => (o.isNumber() ? o.asNumber() : d);

/** Resolves form XObjects by resource name (results cached per resource dictionary). */
function makeResolver(mupdf: MuPDF, resources: PDFObject, inheritedFonts: Map<string, FontInfo>): XObjectResolver {
  const cache = new Map<string, FormXObject | null>();
  return (xname) => {
    if (cache.has(xname)) return cache.get(xname)!;
    let result: FormXObject | null = null;
    try {
      const xdict = resources.isDictionary() ? R(resources.get("XObject")) : null;
      const ref = xdict?.isDictionary() ? xdict.get(xname) : null;
      if (ref && !ref.isNull() && ref.isStream()) {
        const dict = R(ref);
        if (dict.get("Subtype").isName() && dict.get("Subtype").asName() === "Form") {
          const m = R(dict.get("Matrix"));
          const matrix: Matrix = m.isArray() && m.length === 6 ? ([0, 1, 2, 3, 4, 5].map((k) => numOf(m.get(k))) as Matrix) : [...IDENTITY];
          const ownRes = R(dict.get("Resources"));
          const res = ownRes.isDictionary() ? ownRes : resources;
          const fonts = ownRes.isDictionary() ? loadFonts(mupdf, ownRes) : inheritedFonts;
          result = {
            ops: parseContentStream(readStreams([ref])),
            fonts,
            matrix,
            ref,
            resolve: makeResolver(mupdf, res, fonts),
          };
        }
      }
    } catch (e) {
      console.warn("XObject load failed", xname, e);
    }
    cache.set(xname, result);
    return result;
  };
}

export async function loadPage(doc: MDoc, pageIndex: number): Promise<LoadedPage> {
  const mupdf = await loadMupdf();
  const page = doc.loadPage(pageIndex) as MPage;
  const pageObj = page.getObject();
  const ops = parseContentStream(readContents(pageObj));
  const res = R(pageObj.getInheritable("Resources"));
  const fonts = loadFonts(mupdf, res);
  const runs = interpretText(ops, fonts, makeResolver(mupdf, res, fonts));
  const lines = groupRuns(runs);
  const paragraphs = groupParagraphs(lines);
  return { page, pageObj, ops, fonts, runs, lines, paragraphs };
}

const familyOf = (f: FontInfo): FontFamily => (f.mono ? "mono" : f.serif ? "serif" : "sans");
const cleanName = (s: string) => s.replace(/^[A-Z]{6}\+/, "");

function toInfo(p: Paragraph): TextBlockInfo {
  const b = p.lines[0];
  return {
    id: p.id,
    text: p.text,
    bbox: p.bbox,
    origin: b.runs[0].start,
    angle: b.angle,
    size: b.size,
    color: rgbToHex(b.rgb),
    fontName: cleanName(b.font.baseFont),
    family: familyOf(b.font),
    bold: b.font.bold,
    italic: b.font.italic,
    editable: b.font.editable,
    invisible: b.invisible,
    lines: p.lines.length,
    width: p.width,
    leading: p.leading,
    inXObject: b.runs[0].source.id !== "page",
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

/** Lists the editable text blocks (paragraphs) of a page. */
export async function analyzePageText(bytes: Uint8Array, pageIndex: number): Promise<TextBlockInfo[]> {
  const doc = await analysisDoc(bytes);
  const lp = await loadPage(doc, pageIndex);
  return lp.paragraphs.map(toInfo);
}

// ---------------------------------------------------------------------------
// Writing helpers
// ---------------------------------------------------------------------------

const BUILTIN: Record<FontFamily, [string, string, string, string]> = {
  sans: ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"],
  serif: ["Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"],
  mono: ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"],
};

function builtinName(family: FontFamily, bold: boolean, italic: boolean): string {
  return BUILTIN[family][(bold ? 1 : 0) + (italic ? 2 : 0)];
}

function pageResources(doc: MDoc, pageObj: PDFObject): PDFObject {
  let res = pageObj.get("Resources");
  if (res.isNull()) {
    const inherited = pageObj.getInheritable("Resources");
    res = inherited.isNull() ? doc.newDictionary() : R(inherited);
    pageObj.put("Resources", res);
  }
  return R(res);
}

function subDict(doc: MDoc, res: PDFObject, key: string): PDFObject {
  let d = res.get(key);
  if (d.isNull()) {
    d = doc.newDictionary();
    res.put(key, d);
  }
  return R(d);
}

function uniqueKey(dict: PDFObject, prefix: string): string {
  let key = `${prefix}1`;
  for (let i = 1; !dict.get(key).isNull(); i++) key = `${prefix}${i}`;
  return key;
}

/** Adds a built-in Unicode font (embedded as a CID font) to the page resources. */
export async function addBuiltinFont(doc: MDoc, pageObj: PDFObject, fontName: string) {
  const mupdf = await loadMupdf();
  const font = new mupdf.Font(fontName);
  const ref = doc.addFont(font);
  const fontDict = subDict(doc, pageResources(doc, pageObj), "Font");
  const key = uniqueKey(fontDict, "MPF");
  fontDict.put(key, ref);
  return { font, key };
}

/** Makes an existing font object available in the page's own resources; returns its key. */
function pageFontKey(doc: MDoc, pageObj: PDFObject, run: TextRun): string {
  if (run.source.id === "page") return run.font.key;
  const fontDict = subDict(doc, pageResources(doc, pageObj), "Font");
  const key = uniqueKey(fontDict, "MPX");
  fontDict.put(key, run.font.ref as PDFObject);
  return key;
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
function positioningOnly(run: TextRun): Operation[] {
  const original = run.source.ops[run.opIndex];
  if (run.op === "'") return [op("T*")];
  if (run.op === '"') return [op("Tw", original.operands[0]), op("Tc", original.operands[1]), op("T*")];
  return [];
}

function showOp(font: FontInfo, enc: { codes: number[]; spaceGaps: number[] }): Operation {
  if (!enc.spaceGaps.length) return op("Tj", str(codesToBytes(font, enc.codes)));
  const space = font.toUnicode.size ? 278 : 250;
  const items: PdfValue[] = [];
  let from = 0;
  for (const g of enc.spaceGaps) {
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
 * Collects operator replacements per stream (page or form XObject) and writes
 * them back. Form XObjects drawn directly by the page are copied before being
 * modified, so a shared element (e.g. a letterhead) only changes on this page.
 */
class StreamEditor {
  private replace = new Map<StreamSource, Map<number, Operation[]>>();
  private appended: Operation[] = [];

  constructor(
    private doc: MDoc,
    private lp: LoadedPage,
  ) {}

  set(src: StreamSource, index: number, ops: Operation[]) {
    let m = this.replace.get(src);
    if (!m) this.replace.set(src, (m = new Map()));
    m.set(index, ops);
  }

  append(ops: Operation[]) {
    this.appended.push(...ops);
  }

  private flatten(src: StreamSource): Operation[] {
    const m = this.replace.get(src);
    return m ? src.ops.flatMap((o, i) => m.get(i) ?? [o]) : src.ops;
  }

  commit() {
    const { doc, lp } = this;
    // Write form XObjects (deepest first).
    const xsources = [...this.replace.keys()].filter((s) => s.xobject).sort((a, b) => b.id.length - a.id.length);
    for (const src of xsources) {
      const bytes = serializeContentStream(this.flatten(src));
      const x = src.xobject!;
      const ref = x.ref as PDFObject;
      if (x.parent.id === "page") {
        // Copy-on-write: clone the XObject for this page and point this Do at the copy.
        const orig = R(ref);
        const dict = doc.newDictionary();
        const keys: string[] = [];
        orig.forEach((_v, k) => keys.push(String(k)));
        for (const k of keys) if (!["Length", "Filter", "DecodeParms"].includes(k)) dict.put(k, orig.get(k));
        const copy = doc.addStream(bytes, dict);
        const xdict = subDict(doc, pageResources(doc, lp.pageObj), "XObject");
        const key = uniqueKey(xdict, "MPXO");
        xdict.put(key, copy);
        this.set(x.parent, x.doIndex, [op("Do", name(key))]);
      } else {
        // Nested XObject: edit in place.
        ref.writeStream(bytes);
      }
    }
    const pageSource = [...this.replace.keys()].find((s) => s.id === "page");
    const pageOps = pageSource ? this.flatten(pageSource) : lp.ops;
    writeContents(doc, lp.pageObj, this.appended.length ? [op("q"), ...pageOps, op("Q"), ...this.appended] : pageOps);
  }
}

/** Font used to set new text: the original one when it has every glyph, else a built-in one. */
interface Setter {
  key: string;
  name: string;
  substituted: boolean;
  /** Encodes a piece of text into show-operator items. */
  encode(text: string): PdfValue[];
  /** Advance of text in text-space units for font size `tfs` (Tc = 0, Tz applied by caller). */
  measure(text: string, tfs: number): number;
}

async function chooseSetter(doc: MDoc, lp: LoadedPage, run: TextRun, text: string, family: FontFamily | undefined): Promise<Setter> {
  const font = run.font;
  if (!family || family === familyOf(font)) {
    const enc = encodeText(font, text);
    if (enc) {
      const key = pageFontKey(doc, lp.pageObj, run);
      const spaceCode = font.fromUnicode.get(" ");
      const spaceKnown = spaceCode !== undefined && encodeText(font, " ")?.codes.length === 1;
      return {
        key,
        name: cleanName(font.baseFont),
        substituted: false,
        encode: (t) => {
          const shown = showOp(font, encodeText(font, t)!);
          return shown.op === "TJ" ? (shown.operands[0] as { v: PdfValue[] }).v : shown.operands;
        },
        measure: (t, tfs) => {
          let w = 0;
          for (const ch of Array.from(t)) {
            const c = font.fromUnicode.get(ch);
            if (ch === " " && !spaceKnown) w += 0.278 * tfs;
            else if (c !== undefined) w += (font.width(c) / 1000) * tfs;
          }
          return w;
        },
      };
    }
  }
  const fam = family ?? familyOf(font);
  const added = await addBuiltinFont(doc, lp.pageObj, builtinName(fam, font.bold, font.italic));
  return {
    key: added.key,
    name: added.font.getName(),
    substituted: true,
    encode: (t) => [str(encodeForBuiltin(added.font, t))],
    measure: (t, tfs) =>
      Array.from(t).reduce((w, ch) => w + added.font.advanceGlyph(Math.max(0, added.font.encodeCharacter(ch.codePointAt(0)!))) * tfs, 0),
  };
}

const vlen = (m: Matrix, x: number, y: number) => {
  const a = apply(m, 0, 0);
  const b = apply(m, x, y);
  return Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
};

/** Greedy word wrap. Returns lines of words. Hard breaks on "\n". */
function wrap(text: string, firstWidth: number, width: number, measure: (t: string) => number, space: number): string[][] {
  const out: string[][] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    const words = para.split(/ +/).filter((w) => w.length);
    let line: string[] = [];
    let lineW = 0;
    for (const w of words) {
      const ww = measure(w);
      const limit = out.length === 0 && line.length === 0 ? firstWidth : out.length === 0 ? firstWidth : width;
      if (line.length && lineW + space + ww > limit + 0.01) {
        out.push(line);
        line = [w];
        lineW = ww;
      } else {
        lineW += (line.length ? space : 0) + ww;
        line.push(w);
      }
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/**
 * Edits one text block (paragraph).
 *
 * * Single lines are rewritten **in place** in the original font when every
 *   glyph is available; otherwise re-typeset at the same transform.
 * * Multi-line paragraphs are **re-flowed**: the original lines are removed
 *   and the new text is wrapped to the paragraph width with the original line
 *   spacing (and justification, if the paragraph was justified). A pure colour
 *   change is applied in place without re-flowing.
 */
export async function applyTextEdit(bytes: Uint8Array, pageIndex: number, edit: TextEdit): Promise<EditResult> {
  const { doc } = await openMupdf(bytes);
  try {
    const lp = await loadPage(doc, pageIndex);
    const para = lp.paragraphs.find((p) => p.id === edit.blockId);
    if (!para) throw new Error("The text has changed since it was selected. Please try again.");
    const firstLine = para.lines[0];
    const first = firstLine.runs[0];
    const font = firstLine.font;
    if (!font.editable) throw new Error(`Text in the font “${font.baseFont}” cannot be decoded for editing.`);

    const multi = para.lines.length > 1;
    const newText = multi ? edit.text.replace(/\r/g, "") : edit.text.replace(/[\r\n]+/g, " ");
    const sizeScale = edit.size && Math.abs(edit.size - firstLine.size) > 0.01 ? edit.size / firstLine.size : 1;
    const colorChanged = !!edit.color && edit.color.toLowerCase() !== rgbToHex(firstLine.rgb).toLowerCase();
    const moved = Math.abs(edit.dx ?? 0) > 0.01 || Math.abs(edit.dy ?? 0) > 0.01;
    const familyChanged = !!edit.family && edit.family !== familyOf(font);
    const textChanged = newText !== para.text;

    const se = new StreamEditor(doc, lp);
    const allRuns = para.lines.flatMap((l) => l.runs);
    const save = (mode: EditResult["mode"], fontName: string, substituted = false): EditResult => {
      se.commit();
      return { bytes: saveMupdf(doc, "compress"), mode, font: fontName, substituted };
    };

    // Delete.
    if (!newText.trim()) {
      for (const r of allRuns) se.set(r.source, r.opIndex, positioningOnly(r));
      return save("deleted", font.baseFont);
    }

    // Multi-line, colour only: recolour every line in place.
    if (multi && !textChanged && sizeScale === 1 && !moved && !familyChanged && colorChanged) {
      for (const line of para.lines) {
        const rs = line.runs;
        se.set(rs[0].source, rs[0].opIndex, [colorOps(edit.color!), rs[0].source.ops[rs[0].opIndex]]);
        const last = rs[rs.length - 1];
        const lastOps = last === rs[0] ? [colorOps(edit.color!), last.source.ops[last.opIndex]] : [last.source.ops[last.opIndex]];
        se.set(last.source, last.opIndex, [...lastOps, restoreFill(last)]);
      }
      return save("in-place", cleanName(font.baseFont));
    }

    // Single line, in place in the original font.
    if (!multi) {
      const enc = familyChanged ? null : encodeText(font, newText);
      if (enc && !moved) {
        for (const r of allRuns) se.set(r.source, r.opIndex, positioningOnly(r));
        const group: Operation[] = [...positioningOnly(first)];
        if (sizeScale !== 1) group.push(op("Tf", name(font.key), num(+(first.fontSize * sizeScale).toFixed(3))));
        if (colorChanged) group.push(colorOps(edit.color!));
        group.push(showOp(font, enc));
        if (colorChanged) group.push(restoreFill(first));
        if (sizeScale !== 1) group.push(op("Tf", name(font.key), num(first.fontSize)));
        se.set(first.source, first.opIndex, group);
        return save("in-place", cleanName(font.baseFont));
      }
    }

    // Re-typeset (single line) or re-flow (paragraph) as a new text object.
    for (const r of allRuns) se.set(r.source, r.opIndex, positioningOnly(r));
    const setter = await chooseSetter(doc, lp, first, newText.replace(/\n/g, " "), edit.family);
    const ctm: Matrix = moved ? mul(first.ctm, [1, 0, 0, 1, edit.dx ?? 0, edit.dy ?? 0]) : first.ctm;
    const tfs = +(first.fontSize * sizeScale).toFixed(3);
    const th = first.hScale || 1;
    const M = mul(first.tm, first.ctm);
    const scaleX = vlen(M, 1, 0);
    const scaleY = vlen(M, 0, 1);
    const text = ctmOps(ctm);

    const head: Operation[] = [
      op("q"),
      op("cm", ...text),
      op("BT"),
      op("Tf", name(setter.key), num(tfs)),
      colorChanged ? colorOps(edit.color!) : restoreFill(first),
      op("Tr", num(first.renderMode === 7 ? 3 : first.renderMode)),
      op("Tz", num(+(th * 100).toFixed(3))),
      op("Tc", num(0)),
      op("Tw", num(0)),
      op("Ts", num(first.rise)),
      op("Tm", ...first.tm.map((v) => num(+v.toFixed(6)))),
    ];

    if (!multi) {
      se.append([...head, op("TJ", { t: "arr", v: setter.encode(newText) }), op("ET"), op("Q")]);
      return save("retypeset", setter.name, setter.substituted);
    }

    // --- paragraph re-flow ---
    const measure = (t: string) => setter.measure(t, tfs) * th; // text-space units
    const space = measure(" ") || 0.25 * tfs * th;
    const widthTs = (para.width / scaleX) * sizeScale;
    const leadTs = ((para.leading || firstLine.size * 1.2) / scaleY) * sizeScale;
    // First-line indent (line 1 starts right of the other lines).
    const second = para.lines[1].runs[0];
    const dirX = Math.cos(firstLine.angle);
    const dirY = Math.sin(firstLine.angle);
    const indentUser = (first.start[0] - second.start[0]) * dirX + (first.start[1] - second.start[1]) * dirY;
    const indentTs = indentUser > 0.5 ? indentUser / scaleX : 0;
    const lines = wrap(newText, widthTs - indentTs, widthTs, measure, space);
    const body: Operation[] = [];
    lines.forEach((words, i) => {
      if (i === 1 && indentTs) body.push(op("Td", num(+(-indentTs).toFixed(3)), num(+(-leadTs).toFixed(3))));
      else if (i > 0) body.push(op("Td", num(0), num(+(-leadTs).toFixed(3))));
      if (!words.length) return;
      const avail = i === 0 ? widthTs - indentTs : widthTs;
      const natural = words.reduce((w, x) => w + measure(x), 0) + space * (words.length - 1);
      // Justify all but the last line of each hard paragraph.
      const isLastOfPara = i === lines.length - 1 || lines[i + 1].length === 0;
      const extra = para.justified && !isLastOfPara && words.length > 1 ? (avail - natural) / (words.length - 1) : 0;
      const items: PdfValue[] = [];
      words.forEach((w, k) => {
        if (k > 0) {
          items.push(...setter.encode(" "));
          if (Math.abs(extra) > 0.001) items.push(num(+((-extra * 1000) / (tfs * th)).toFixed(2)));
        }
        items.push(...setter.encode(w));
      });
      body.push(op("TJ", { t: "arr", v: items }));
    });
    se.append([...head, ...body, op("ET"), op("Q")]);
    return save("reflowed", setter.name, setter.substituted);
  } finally {
    doc.destroy();
  }
}

function ctmOps(m: Matrix): PdfValue[] {
  return m.map((v) => num(+v.toFixed(6)));
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
  /** Optional wrap width (user units). */
  width?: number;
}

/** Adds new text to the page as real page content (multi-line, optional wrapping). */
export async function insertText(bytes: Uint8Array, pageIndex: number, o: InsertTextOptions): Promise<{ bytes: Uint8Array; font: string }> {
  const { doc } = await openMupdf(bytes);
  try {
    const lp = await loadPage(doc, pageIndex);
    const added = await addBuiltinFont(doc, lp.pageObj, builtinName(o.family, !!o.bold, !!o.italic));
    const measure = (t: string) =>
      Array.from(t).reduce((w, ch) => w + added.font.advanceGlyph(Math.max(0, added.font.encodeCharacter(ch.codePointAt(0)!))) * o.size, 0);
    const lines = o.width
      ? wrap(o.text, o.width, o.width, measure, measure(" ")).map((ws) => ws.join(" "))
      : o.text.replace(/\r/g, "").split("\n");
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
