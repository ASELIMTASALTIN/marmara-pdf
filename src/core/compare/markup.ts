import type { Annotation, Rect } from "../annotations/types";
import type { CompareResult } from "./compare";

/** Groups word rectangles on the same line into one rectangle per line. */
export function lineRects(rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of [...rects].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - r[1]) < (r[3] - r[1]) * 0.5 && r[0] - last[2] < (r[3] - r[1]) * 1.5) {
      last[2] = Math.max(last[2], r[2]);
      last[1] = Math.min(last[1], r[1]);
      last[3] = Math.max(last[3], r[3]);
    } else out.push([...r] as Rect);
  }
  return out;
}

/**
 * Turns a comparison into annotations on the *new* document: added text is
 * highlighted in green, removed text becomes a red note where it used to be.
 * Returns annotations per 0-based page.
 */
export function changesToAnnotations(result: CompareResult, newId: () => string): Map<number, Annotation[]> {
  const out = new Map<number, Annotation[]>();
  const push = (page: number, a: Annotation) => out.set(page, [...(out.get(page) ?? []), a]);
  for (const c of result.changes) {
    if (c.kind === "inserted") {
      const byPage = new Map<number, Rect[]>();
      for (const w of c.words) byPage.set(w.page, [...(byPage.get(w.page) ?? []), w.rect]);
      for (const [page, rects] of byPage)
        push(page, { id: newId(), type: "highlight", rects: lineRects(rects), text: c.text, color: "#2da44e", opacity: 0.4, createdAt: Date.now(), comment: "Added" });
    } else if (c.anchor) {
      push(c.anchor.page, { id: newId(), type: "note", point: [c.anchor.point[0] + 2, c.anchor.point[1] + 4], text: `Removed: ${c.text}`, color: "#ff6b6b", opacity: 1, createdAt: Date.now() });
    }
  }
  return out;
}
