import type { Point, Rect } from "./types";

/** Minimal viewport interface (pdf.js PageViewport). */
export interface ViewportLike {
  convertToViewportPoint(x: number, y: number): number[];
  convertToPdfPoint(x: number, y: number): number[];
  rotation: number;
  scale: number;
  width: number;
  height: number;
}

export const toView = (vp: ViewportLike, p: Point): Point => vp.convertToViewportPoint(p[0], p[1]) as Point;
export const toPdf = (vp: ViewportLike, x: number, y: number): Point => vp.convertToPdfPoint(x, y) as Point;

export function normRect(r: Rect): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

/** Axis-aligned view-space box of a PDF rect (pages only rotate by multiples of 90°). */
export function rectToView(vp: ViewportLike, r: Rect): { x: number; y: number; w: number; h: number } {
  const a = toView(vp, [r[0], r[1]]);
  const b = toView(vp, [r[2], r[3]]);
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return { x, y, w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

/** PDF rect from two view-space corner points. */
export function viewRectToPdf(vp: ViewportLike, x0: number, y0: number, x1: number, y1: number): Rect {
  const a = toPdf(vp, x0, y0);
  const b = toPdf(vp, x1, y1);
  return normRect([a[0], a[1], b[0], b[1]]);
}

export function translateRect(r: Rect, dx: number, dy: number): Rect {
  return [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
}

/** Merges per-glyph/per-span rects into one rect per text line. */
export function mergeLineRects(rects: Rect[], tolerance = 0.35): Rect[] {
  const sorted = rects
    .filter((r) => r[2] - r[0] > 0.1 && r[3] - r[1] > 0.1)
    .sort((a, b) => b[3] - a[3] || a[0] - b[0]);
  const out: Rect[] = [];
  for (const r of sorted) {
    const h = r[3] - r[1];
    const last = out.find((o) => {
      const oh = o[3] - o[1];
      const overlap = Math.min(o[3], r[3]) - Math.max(o[1], r[1]);
      return overlap > tolerance * Math.min(h, oh) && r[0] <= o[2] + h * 1.2 && r[2] >= o[0] - h * 1.2;
    });
    if (last) {
      last[0] = Math.min(last[0], r[0]);
      last[1] = Math.min(last[1], r[1]);
      last[2] = Math.max(last[2], r[2]);
      last[3] = Math.max(last[3], r[3]);
    } else out.push([...r] as Rect);
  }
  return out;
}

function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

/** Ramer–Douglas–Peucker path simplification. */
export function simplifyPath(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], points[0], points[points.length - 1]);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= tolerance) return [points[0], points[points.length - 1]];
  const left = simplifyPath(points.slice(0, idx + 1), tolerance);
  const right = simplifyPath(points.slice(idx), tolerance);
  return [...left.slice(0, -1), ...right];
}

export function svgPath(points: Point[]): string {
  if (!points.length) return "";
  if (points.length === 1) return `M${points[0][0]},${points[0][1]}l0.01,0`;
  let d = `M${points[0][0].toFixed(2)},${points[0][1].toFixed(2)}`;
  // Quadratic smoothing through midpoints.
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += ` Q${x.toFixed(2)},${y.toFixed(2)} ${((x + nx) / 2).toFixed(2)},${((y + ny) / 2).toFixed(2)}`;
  }
  const last = points[points.length - 1];
  return d + ` L${last[0].toFixed(2)},${last[1].toFixed(2)}`;
}
