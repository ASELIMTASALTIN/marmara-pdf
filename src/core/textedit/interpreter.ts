import type { Operation, PdfValue } from "./contentStream";
import { codesToText, decodeCodes, sameFont, type FontInfo } from "./fonts";
import type { Point, Rect } from "../annotations/types";

export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 then m2 (PDF row-vector convention). */
export function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}
export const apply = (m: Matrix, x: number, y: number): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export interface FillColor {
  /** Operator that set the colour, replayable verbatim. */
  op: Operation | null;
  rgb: [number, number, number];
}

/**
 * A content stream containing text: the page itself, or a form XObject drawn
 * by a `Do` operator (possibly nested).
 */
export interface StreamSource {
  /** "page", or `${parent.id}/${doIndex}` for form XObjects. */
  id: string;
  ops: Operation[];
  fonts: Map<string, FontInfo>;
  /** For form XObjects: how the XObject is drawn from its parent stream. */
  xobject?: { name: string; doIndex: number; parent: StreamSource; ref: unknown };
}

/** Loaded form XObject, provided by the caller (needs PDF object access). */
export interface FormXObject {
  ops: Operation[];
  fonts: Map<string, FontInfo>;
  matrix: Matrix;
  ref: unknown;
  /** Resolver for XObjects nested inside this one. */
  resolve: XObjectResolver;
}
export type XObjectResolver = (name: string) => FormXObject | null;

/** One text-showing operator (Tj, TJ, ' or ") with its decoded text and geometry. */
export interface TextRun {
  source: StreamSource;
  opIndex: number;
  op: string;
  font: FontInfo;
  fontSize: number;
  codes: number[];
  text: string;
  /** Text matrix and CTM (user space of the page) in effect when the operator starts. */
  tm: Matrix;
  ctm: Matrix;
  charSpacing: number;
  wordSpacing: number;
  hScale: number; // Tz / 100
  rise: number;
  renderMode: number;
  fill: FillColor;
  /** Baseline start / end in user space. */
  start: Point;
  end: Point;
  /** Axis-aligned bounds in user space. */
  bbox: Rect;
  /** Baseline angle in user space, radians. */
  angle: number;
  /** Effective font size in user space. */
  size: number;
}

interface GState {
  ctm: Matrix;
  fill: FillColor;
  fillSpace: string;
  font: FontInfo | null;
  fontSize: number;
  Tc: number;
  Tw: number;
  Th: number;
  TL: number;
  Ts: number;
  Tr: number;
}

const n = (v: PdfValue | undefined): number => (v && v.t === "num" ? v.v : 0);

function cmykToRgb(c: number, m: number, y: number, k: number): [number, number, number] {
  return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
}

function colorFrom(op: Operation, space: string): [number, number, number] | null {
  const vals = op.operands.filter((o) => o.t === "num").map((o) => (o as { v: number }).v);
  switch (op.op) {
    case "g":
      return [vals[0], vals[0], vals[0]];
    case "rg":
      return [vals[0], vals[1], vals[2]];
    case "k":
      return cmykToRgb(vals[0], vals[1], vals[2], vals[3]);
    case "sc":
    case "scn":
      if (vals.length === 1 && (space === "DeviceGray" || space === "CalGray" || space === "")) return [vals[0], vals[0], vals[0]];
      if (vals.length === 3) return [vals[0], vals[1], vals[2]];
      if (vals.length === 4) return cmykToRgb(vals[0], vals[1], vals[2], vals[3]);
      return null;
  }
  return null;
}

const MAX_XOBJECT_DEPTH = 4;

/**
 * Interprets a content stream far enough to locate every text-showing
 * operator and compute its decoded text and position. Form XObjects drawn
 * with `Do` are descended into (when a resolver is given).
 */
export function interpretText(ops: Operation[], fonts: Map<string, FontInfo>, resolve?: XObjectResolver): TextRun[] {
  const runs: TextRun[] = [];
  const page: StreamSource = { id: "page", ops, fonts };
  const initial: GState = {
    ctm: [...IDENTITY] as Matrix,
    fill: { op: null, rgb: [0, 0, 0] },
    fillSpace: "DeviceGray",
    font: null,
    fontSize: 0,
    Tc: 0,
    Tw: 0,
    Th: 1,
    TL: 0,
    Ts: 0,
    Tr: 0,
  };
  interpretStream(page, initial, resolve, 0, runs);
  return runs;
}

function interpretStream(src: StreamSource, start: GState, resolve: XObjectResolver | undefined, depth: number, runs: TextRun[]) {
  const stack: GState[] = [];
  let gs: GState = { ...start, ctm: [...start.ctm] as Matrix };
  let tm: Matrix = [...IDENTITY] as Matrix;
  let tlm: Matrix = [...IDENTITY] as Matrix;
  const fonts = src.fonts;

  const nextLine = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = [...tlm] as Matrix;
  };

  const show = (index: number, opName: string, items: PdfValue[]) => {
    const font = gs.font;
    if (!font) return;
    const startTm = [...tm] as Matrix;
    const allCodes: number[] = [];
    let x = 0; // advance in unscaled text space (before Tm)
    for (const it of items) {
      if (it.t === "num") {
        x -= (it.v / 1000) * gs.fontSize * gs.Th;
        continue;
      }
      if (it.t !== "str") continue;
      for (const code of decodeCodes(font, it.v)) {
        font.usedCodes.add(code);
        allCodes.push(code);
        const w0 = font.width(code) / 1000;
        const isSpace = font.bytesPerCode === 1 && code === 32;
        x += (w0 * gs.fontSize + gs.Tc + (isSpace ? gs.Tw : 0)) * gs.Th;
      }
    }
    tm = mul([1, 0, 0, 1, x, 0], tm);
    if (!allCodes.length) return;
    const m = mul(startTm, gs.ctm);
    const asc = (font.ascent / 1000) * gs.fontSize;
    const desc = (font.descent / 1000) * gs.fontSize;
    const corners = [apply(m, 0, gs.Ts + desc), apply(m, x, gs.Ts + desc), apply(m, x, gs.Ts + asc), apply(m, 0, gs.Ts + asc)];
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const s0 = apply(m, 0, gs.Ts);
    const e0 = apply(m, x, gs.Ts);
    const up = apply(m, 0, gs.Ts + gs.fontSize);
    runs.push({
      source: src,
      opIndex: index,
      op: opName,
      font,
      fontSize: gs.fontSize,
      codes: allCodes,
      text: codesToText(font, allCodes),
      tm: startTm,
      ctm: [...gs.ctm] as Matrix,
      charSpacing: gs.Tc,
      wordSpacing: gs.Tw,
      hScale: gs.Th,
      rise: gs.Ts,
      renderMode: gs.Tr,
      fill: gs.fill,
      start: s0,
      end: e0,
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      angle: Math.atan2(e0[1] - s0[1], e0[0] - s0[0]) || Math.atan2(m[1], m[0]),
      size: Math.hypot(up[0] - s0[0], up[1] - s0[1]),
    });
  };

  src.ops.forEach((o, i) => {
    const a = o.operands;
    switch (o.op) {
      case "q":
        stack.push({ ...gs, ctm: [...gs.ctm] as Matrix });
        break;
      case "Q":
        if (stack.length) gs = stack.pop()!;
        break;
      case "cm":
        gs.ctm = mul([n(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]), n(a[5])], gs.ctm);
        break;
      case "cs":
        gs.fillSpace = a[0]?.t === "name" ? a[0].v : "";
        break;
      case "g":
      case "rg":
      case "k":
      case "sc":
      case "scn": {
        const rgb = colorFrom(o, o.op === "g" ? "DeviceGray" : gs.fillSpace);
        if (o.op === "g") gs.fillSpace = "DeviceGray";
        if (o.op === "rg") gs.fillSpace = "DeviceRGB";
        if (o.op === "k") gs.fillSpace = "DeviceCMYK";
        gs.fill = { op: o, rgb: rgb ?? gs.fill.rgb };
        break;
      }
      case "BT":
        tm = [...IDENTITY] as Matrix;
        tlm = [...IDENTITY] as Matrix;
        break;
      case "Tf": {
        const key = a[0]?.t === "name" ? a[0].v : "";
        gs.font = fonts.get(key) ?? null;
        gs.fontSize = n(a[1]);
        break;
      }
      case "Tc":
        gs.Tc = n(a[0]);
        break;
      case "Tw":
        gs.Tw = n(a[0]);
        break;
      case "Tz":
        gs.Th = n(a[0]) / 100;
        break;
      case "TL":
        gs.TL = n(a[0]);
        break;
      case "Ts":
        gs.Ts = n(a[0]);
        break;
      case "Tr":
        gs.Tr = n(a[0]);
        break;
      case "Td":
        nextLine(n(a[0]), n(a[1]));
        break;
      case "TD":
        gs.TL = -n(a[1]);
        nextLine(n(a[0]), n(a[1]));
        break;
      case "Tm":
        tlm = [n(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]), n(a[5])];
        tm = [...tlm] as Matrix;
        break;
      case "T*":
        nextLine(0, -gs.TL);
        break;
      case "Tj":
        show(i, "Tj", a.slice(0, 1));
        break;
      case "TJ":
        show(i, "TJ", a[0]?.t === "arr" ? a[0].v : []);
        break;
      case "'":
        nextLine(0, -gs.TL);
        show(i, "'", a.slice(0, 1));
        break;
      case '"':
        gs.Tw = n(a[0]);
        gs.Tc = n(a[1]);
        nextLine(0, -gs.TL);
        show(i, '"', a.slice(2, 3));
        break;
      case "Do": {
        if (!resolve || depth >= MAX_XOBJECT_DEPTH || a[0]?.t !== "name") break;
        const x = resolve(a[0].v);
        if (!x) break;
        const child: StreamSource = {
          id: `${src.id}/${i}`,
          ops: x.ops,
          fonts: x.fonts,
          xobject: { name: a[0].v, doIndex: i, parent: src, ref: x.ref },
        };
        // A form XObject inherits the graphics state; its matrix maps form space to the current user space.
        interpretStream(child, { ...gs, ctm: mul(x.matrix, gs.ctm) }, x.resolve, depth + 1, runs);
        break;
      }
    }
  });
}

/** A visually contiguous piece of text (one line) offered for editing as a unit. */
export interface TextBlock {
  id: string;
  runs: TextRun[];
  text: string;
  bbox: Rect;
  font: FontInfo;
  size: number;
  angle: number;
  rgb: [number, number, number];
  invisible: boolean;
}

/** Groups consecutive runs of the same style on the same baseline into line blocks. */
export function groupRuns(runs: TextRun[]): TextBlock[] {
  const blocks: TextBlock[] = [];
  let cur: TextBlock | null = null;
  for (const r of runs) {
    if (!r.text.trim() && !cur) continue;
    const invisible = r.renderMode === 3 || r.renderMode === 7;
    if (cur) {
      const last = cur.runs[cur.runs.length - 1];
      const h = Math.max(cur.size, 1);
      const cos = Math.cos(cur.angle);
      const sin = Math.sin(cur.angle);
      const dx = r.start[0] - last.end[0];
      const dy = r.start[1] - last.end[1];
      const along = dx * cos + dy * sin;
      const perp = -dx * sin + dy * cos;
      const same =
        r.source === last.source &&
        sameFont(r.font, cur.font) &&
        Math.abs(r.size - cur.size) < 0.02 * h &&
        Math.abs(r.angle - cur.angle) < 0.02 &&
        r.fill.rgb.every((v, k) => Math.abs(v - cur!.rgb[k]) < 0.02) &&
        invisible === cur.invisible &&
        Math.abs(perp) < 0.25 * h &&
        along > -0.5 * h &&
        along < 1.2 * h;
      if (same) {
        const needSpace = along > 0.2 * h && !/\s$/.test(cur.text) && !/^\s/.test(r.text);
        cur.text += (needSpace ? " " : "") + r.text;
        cur.runs.push(r);
        cur.bbox = [Math.min(cur.bbox[0], r.bbox[0]), Math.min(cur.bbox[1], r.bbox[1]), Math.max(cur.bbox[2], r.bbox[2]), Math.max(cur.bbox[3], r.bbox[3])];
        continue;
      }
    }
    if (!r.text.trim()) {
      cur = null;
      continue;
    }
    cur = {
      id: `b${r.source.id === "page" ? "" : r.source.id.replace(/\//g, "_") + "_"}${r.opIndex}`,
      runs: [r],
      text: r.text,
      bbox: [...r.bbox] as Rect,
      font: r.font,
      size: r.size,
      angle: r.angle,
      rgb: r.fill.rgb,
      invisible,
    };
    blocks.push(cur);
  }
  for (const b of blocks) b.text = b.text.replace(/\s+$/, "");
  return blocks.filter((b) => b.text.length > 0);
}

/** Lines that form one paragraph (same style, regular line spacing, aligned left edges). */
export interface Paragraph {
  id: string;
  lines: TextBlock[];
  text: string;
  bbox: Rect;
  /** Distance between baselines in user space (0 for single lines). */
  leading: number;
  /** Width available for text along the baseline, in user space. */
  width: number;
  justified: boolean;
}

function lineLength(b: TextBlock): number {
  const s = b.runs[0].start;
  const e = b.runs[b.runs.length - 1].end;
  return Math.hypot(e[0] - s[0], e[1] - s[1]);
}

/** Joins lines of a paragraph into running text (de-hyphenating line ends). */
export function joinLines(lines: string[]): string {
  let out = "";
  for (const l of lines) {
    const t = l.trim();
    if (!out) out = t;
    else if (/[A-Za-zÀ-ÿĞğŞşİı]-$/.test(out) && /^[a-zà-ÿğşıöüç]/.test(t)) out = out.slice(0, -1) + t;
    else out += " " + t;
  }
  return out;
}

/** Groups consecutive line blocks into paragraphs. */
export function groupParagraphs(lines: TextBlock[]): Paragraph[] {
  const paras: Paragraph[] = [];
  let cur: TextBlock[] = [];
  let leading = 0;

  const flush = () => {
    if (!cur.length) return;
    const first = cur[0];
    const bbox = cur.reduce<Rect>(
      (b, l) => [Math.min(b[0], l.bbox[0]), Math.min(b[1], l.bbox[1]), Math.max(b[2], l.bbox[2]), Math.max(b[3], l.bbox[3])],
      [...first.bbox] as Rect,
    );
    const lens = cur.map(lineLength);
    const width = Math.max(...lens);
    // Justified: every line but the last fills (almost) the full width.
    const justified = cur.length >= 3 && lens.slice(0, -1).every((l) => l > width * 0.97);
    paras.push({
      id: `p${first.id}`,
      lines: cur,
      text: joinLines(cur.map((l) => l.text)),
      bbox,
      leading: cur.length > 1 ? leading : 0,
      width,
      justified,
    });
    cur = [];
    leading = 0;
  };

  for (const line of lines) {
    if (!cur.length) {
      cur = [line];
      continue;
    }
    const prev = cur[cur.length - 1];
    const h = Math.max(prev.size, 1);
    const cos = Math.cos(prev.angle);
    const sin = Math.sin(prev.angle);
    const p0 = prev.runs[0].start;
    const p1 = line.runs[0].start;
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const along = dx * cos + dy * sin; // left-edge offset
    const down = dx * sin - dy * cos; // positive when the line is below
    const sameStyle =
      line.runs[0].source === prev.runs[0].source &&
      sameFont(line.font, prev.font) &&
      Math.abs(line.size - prev.size) < 0.03 * h &&
      Math.abs(line.angle - prev.angle) < 0.02 &&
      line.invisible === prev.invisible &&
      line.rgb.every((v, k) => Math.abs(v - prev.rgb[k]) < 0.02);
    const regular = down > h * 0.95 && down < h * 1.9 && (!leading || Math.abs(down - leading) < h * 0.15);
    // Allow a first-line indent: line 2 may start left of line 1; later lines must align.
    const aligned = cur.length === 1 ? along <= h * 0.2 && along > -h * 4 : Math.abs(along - 0) < h * 0.5 || Math.abs(line.runs[0].start[0] - cur[1].runs[0].start[0]) < h * 0.5;
    if (sameStyle && regular && aligned) {
      if (!leading) leading = down;
      cur.push(line);
    } else {
      flush();
      cur = [line];
    }
  }
  flush();
  return paras;
}
