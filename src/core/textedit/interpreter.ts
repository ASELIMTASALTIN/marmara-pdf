import type { Operation, PdfValue } from "./contentStream";
import { codesToText, decodeCodes, type FontInfo } from "./fonts";
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

/** One text-showing operator (Tj, TJ, ' or ") with its decoded text and geometry. */
export interface TextRun {
  opIndex: number;
  op: string;
  font: FontInfo;
  fontSize: number;
  codes: number[];
  text: string;
  /** Text matrix and CTM in effect when the operator starts. */
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

/**
 * Interprets a content stream far enough to locate every text-showing
 * operator and compute its decoded text and position. Text inside form
 * XObjects is not descended into (it is not editable in place).
 */
export function interpretText(ops: Operation[], fonts: Map<string, FontInfo>): TextRun[] {
  const runs: TextRun[] = [];
  const stack: GState[] = [];
  let gs: GState = {
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
  let tm: Matrix = [...IDENTITY] as Matrix;
  let tlm: Matrix = [...IDENTITY] as Matrix;

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
      const codes = decodeCodes(font, it.v);
      for (const code of codes) {
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
    const start = apply(m, 0, gs.Ts);
    const end = apply(m, x, gs.Ts);
    const up = apply(m, 0, gs.Ts + gs.fontSize);
    runs.push({
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
      start,
      end,
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      angle: Math.atan2(end[1] - start[1], end[0] - start[0]) || Math.atan2(m[1], m[0]),
      size: Math.hypot(up[0] - start[0], up[1] - start[1]),
    });
  };

  ops.forEach((o, i) => {
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
    }
  });
  return runs;
}

/** A visually contiguous piece of text (usually one line) offered for editing as a unit. */
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
        r.font === cur.font &&
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
      id: `b${r.opIndex}`,
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
