import type { Annotation, Point, Rect } from "./types";
import { translateRect } from "./geometry";

const tp = (p: Point, dx: number, dy: number): Point => [p[0] + dx, p[1] + dy];

/** Returns a copy of the annotation moved by (dx, dy) in PDF space. */
export function moveAnnotation<T extends Annotation>(a: T, dx: number, dy: number): T {
  switch (a.type) {
    case "highlight":
    case "underline":
    case "strikeout":
      return { ...a, rects: a.rects.map((r) => translateRect(r, dx, dy)) };
    case "ink":
      return { ...a, paths: a.paths.map((path) => path.map((p) => tp(p, dx, dy))) };
    case "line":
    case "arrow":
      return { ...a, from: tp(a.from, dx, dy), to: tp(a.to, dx, dy) };
    case "note":
      return { ...a, point: tp(a.point, dx, dy) };
    default:
      return { ...a, rect: translateRect((a as { rect: Rect }).rect, dx, dy) };
  }
}

export const isResizable = (a: Annotation) =>
  a.type === "rect" || a.type === "ellipse" || a.type === "freetext" || a.type === "image" || a.type === "signature";
export const hasEndpoints = (a: Annotation) => a.type === "line" || a.type === "arrow";
export const isMovable = (_a: Annotation) => true;
