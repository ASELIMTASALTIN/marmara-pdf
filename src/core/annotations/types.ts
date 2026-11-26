/**
 * Annotation model. All geometry is in PDF user space of the *unrotated* page
 * (origin bottom-left, units = points), so annotations stay correct when a
 * page is rotated or the zoom changes. Overlays convert to screen space via
 * the pdf.js viewport.
 */

export type Point = [number, number];
/** [x0, y0, x1, y1] with x0<x1, y0<y1 in PDF space. */
export type Rect = [number, number, number, number];

interface Base {
  id: string;
  color: string; // #rrggbb
  opacity: number; // 0..1
  createdAt: number;
  author?: string;
  /** Optional comment shown in the notes panel. */
  comment?: string;
}

export interface TextMarkupAnnotation extends Base {
  type: "highlight" | "underline" | "strikeout";
  /** One rect per line fragment. */
  rects: Rect[];
  text: string;
}

export interface InkAnnotation extends Base {
  type: "ink";
  width: number;
  paths: Point[][];
}

export interface ShapeAnnotation extends Base {
  type: "rect" | "ellipse";
  rect: Rect;
  width: number;
  fill?: string | null;
}

export interface LineAnnotation extends Base {
  type: "line" | "arrow";
  from: Point;
  to: Point;
  width: number;
}

export interface FreeTextAnnotation extends Base {
  type: "freetext";
  rect: Rect;
  text: string;
  fontSize: number;
}

export interface NoteAnnotation extends Base {
  type: "note";
  point: Point;
  text: string;
}

export interface ImageAnnotation extends Base {
  type: "signature" | "image";
  rect: Rect;
  /** PNG/JPEG data URL. */
  dataUrl: string;
}

export type Annotation =
  | TextMarkupAnnotation
  | InkAnnotation
  | ShapeAnnotation
  | LineAnnotation
  | FreeTextAnnotation
  | NoteAnnotation
  | ImageAnnotation;

export type AnnotationType = Annotation["type"];

/** Annotations of a document, keyed by stable page id. */
export type AnnotationMap = Record<string, Annotation[]>;

export function annotationBounds(a: Annotation): Rect {
  switch (a.type) {
    case "highlight":
    case "underline":
    case "strikeout":
      return a.rects.reduce<Rect>(
        (b, r) => [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])],
        [Infinity, Infinity, -Infinity, -Infinity],
      );
    case "ink": {
      const pts = a.paths.flat();
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const pad = a.width / 2;
      return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
    }
    case "line":
    case "arrow": {
      const pad = a.width * 3;
      return [
        Math.min(a.from[0], a.to[0]) - pad,
        Math.min(a.from[1], a.to[1]) - pad,
        Math.max(a.from[0], a.to[0]) + pad,
        Math.max(a.from[1], a.to[1]) + pad,
      ];
    }
    case "note":
      return [a.point[0], a.point[1] - 20, a.point[0] + 20, a.point[1]];
    default:
      return a.rect;
  }
}

export function countAnnotations(map: AnnotationMap): number {
  return Object.values(map).reduce((n, list) => n + list.length, 0);
}
