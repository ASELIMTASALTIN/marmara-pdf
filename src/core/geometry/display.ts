import { invertMatrix, openMupdf, transformPoint, type Matrix } from "../mupdf/loader";
import type { Point, Rect } from "../annotations/types";

// ---------- coordinates ----------
// The CLI speaks "display" coordinates: points, origin at the top-left corner
// of the page as shown (rotation and crop box applied), y growing downwards —
// the same frame as a rendered image (pixel = point × dpi / 72).

export interface PageGeom {
  width: number;
  height: number;
  rotation: number;
  /** User space → display space. */
  m: Matrix;
  inv: Matrix;
}

export async function pageGeometries(bytes: Uint8Array): Promise<PageGeom[]> {
  const { doc } = await openMupdf(bytes);
  try {
    const out: PageGeom[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i) as import("mupdf").PDFPage;
      const b = page.getBounds();
      const m = page.getTransform() as Matrix;
      const rot = page.getObject().get("Rotate");
      out.push({ width: b[2] - b[0], height: b[3] - b[1], rotation: rot.isNull() ? 0 : ((rot.asNumber() % 360) + 360) % 360, m, inv: invertMatrix(m) });
    }
    return out;
  } finally {
    doc.destroy();
  }
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export const toUser = (g: PageGeom, p: number[]): Point => transformPoint(g.inv, p[0], p[1]);
export const fromUser = (g: PageGeom, p: number[]): Point => {
  const q = transformPoint(g.m, p[0], p[1]);
  return [r2(q[0]), r2(q[1])];
};

function mapRect(m: Matrix, r: number[]): Rect {
  const a = transformPoint(m, r[0], r[1]);
  const b = transformPoint(m, r[2], r[3]);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

export const rectToUser = (g: PageGeom, r: number[]): Rect => {
  if (r[2] <= r[0] || r[3] <= r[1]) throw new RangeError(`Invalid rectangle ${r.join(",")}: expected x0<x1 and y0<y1.`);
  return mapRect(g.inv, r);
};
export const rectFromUser = (g: PageGeom, r: number[]): Rect => mapRect(g.m, r).map(r2) as Rect;
/** A displacement in display space → user space. */
export const vecToUser = (g: PageGeom, d: number[]): Point => [g.inv[0] * d[0] + g.inv[2] * d[1], g.inv[1] * d[0] + g.inv[3] * d[1]];
/** Unit vector in user space for a display-space direction. */
export const dirToUser = (g: PageGeom, d: number[]): Point => {
  const v = vecToUser(g, d);
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};
export const round2 = r2;
