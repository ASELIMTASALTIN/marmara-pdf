import type { Point } from "../annotations/types";
import type { OcrLine } from "./recognize";
import type { OcrLineGeom } from "./textLayer";

function unit(a: Point, b: Point): Point {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

/** Converts recognised pixel lines to PDF-space line geometry. */
export function toGeometry(lines: OcrLine[], vp: { convertToPdfPoint(x: number, y: number): number[]; scale: number }): OcrLineGeom[] {
  const P = (x: number, y: number) => vp.convertToPdfPoint(x, y) as Point;
  const s = vp.scale;
  return lines.map((l) => {
    const first = l.words[0];
    const slope = (l.baseline[1] - l.baseline[0]) / Math.max(1, l.x1 - l.x0);
    const baseAt = (x: number) => l.baseline[0] + slope * (x - l.x0);
    const by = baseAt(first.x0);
    // Size from the ascent above the baseline (cap/ascender height ≈ 0.72 em).
    const ascentPx = Math.max(4, by - l.y0);
    return {
      origin: P(first.x0, by),
      dir: unit(P(first.x0, by), P(first.x0 + 100, by)),
      up: unit(P(first.x0, by), P(first.x0, by - 100)),
      size: ascentPx / 0.72 / s,
      words: l.words.map((w) => ({ text: w.text, start: (w.x0 - first.x0) / s, width: (w.x1 - w.x0) / s })),
    };
  });
}
