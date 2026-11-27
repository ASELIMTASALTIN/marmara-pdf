import type { Rect } from "../annotations/types";
import { hexToRgb, loadMupdf, openMupdf, saveMupdf } from "../mupdf/loader";
import { name, num, type Operation } from "../textedit/contentStream";
import { apply, IDENTITY, mul, type Matrix } from "../textedit/interpreter";
import { loadPage, op, writeContents } from "../textedit/editor";
import { invertMatrix } from "../mupdf/loader";

type PDFObject = import("mupdf").PDFObject;
const R = (o: PDFObject): PDFObject => (o.isNull() ? o : o.resolve());

/** An image or vector path drawn directly by the page content. */
export interface PageObject {
  id: string;
  kind: "image" | "path";
  /** Operator range [start, end] (inclusive) in the page stream. */
  start: number;
  end: number;
  /** Bounds in PDF user space. */
  bbox: Rect;
  /** For paths: how it is painted. */
  fill?: boolean;
  stroke?: boolean;
  /** CTM at the object. */
  ctm: Matrix;
  /** Image XObject resource name (images drawn with Do). */
  xobject?: string;
}

const PAINT = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);
const CONSTRUCT = new Set(["m", "l", "c", "v", "y", "h", "re"]);

/** Finds images and painted paths in an operator list. */
export function findObjects(ops: Operation[], imageNames: Set<string>): PageObject[] {
  const out: PageObject[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = [...IDENTITY] as Matrix;
  let pathStart = -1;
  let pts: [number, number][] = [];
  let clip = false;
  let inText = false;
  const nums = (o: Operation) => o.operands.map((v) => (v.t === "num" ? v.v : 0));
  const bboxOf = (points: [number, number][]): Rect => {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  ops.forEach((o, i) => {
    switch (o.op) {
      case "BT":
        inText = true;
        return;
      case "ET":
        inText = false;
        return;
      case "q":
        stack.push(ctm);
        return;
      case "Q":
        ctm = stack.pop() ?? ([...IDENTITY] as Matrix);
        return;
      case "cm":
        ctm = mul(nums(o) as Matrix, ctm);
        return;
      case "W":
      case "W*":
        clip = true;
        return;
      case "Do": {
        const n = o.operands[0]?.t === "name" ? o.operands[0].v : "";
        if (!imageNames.has(n) || inText) return;
        const corners: [number, number][] = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 1, 1), apply(ctm, 0, 1)];
        out.push({ id: `o${i}`, kind: "image", start: i, end: i, bbox: bboxOf(corners), ctm, xobject: n });
        return;
      }
      case "BI": {
        const corners: [number, number][] = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 1, 1), apply(ctm, 0, 1)];
        out.push({ id: `o${i}`, kind: "image", start: i, end: i, bbox: bboxOf(corners), ctm });
        return;
      }
    }
    if (CONSTRUCT.has(o.op)) {
      if (pathStart < 0) pathStart = i;
      const v = nums(o);
      if (o.op === "re") {
        const [x, y, w, h] = v;
        pts.push(apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h));
      } else for (let k = 0; k + 1 < v.length; k += 2) pts.push(apply(ctm, v[k], v[k + 1]));
      return;
    }
    if (PAINT.has(o.op)) {
      if (pathStart >= 0 && pts.length && !clip && o.op !== "n") {
        const fill = /^[fFBb]/.test(o.op);
        const stroke = /^[SsBb]/.test(o.op);
        const bb = bboxOf(pts);
        // Ignore page-filling backgrounds is left to the UI; keep everything.
        out.push({ id: `o${pathStart}`, kind: "path", start: pathStart, end: i, bbox: bb, fill, stroke, ctm });
      }
      pathStart = -1;
      pts = [];
      clip = false;
    }
  });
  return out;
}

async function pageObjects(doc: import("mupdf").PDFDocument, pageIndex: number) {
  const lp = await loadPage(doc, pageIndex);
  const res = R(lp.pageObj.getInheritable("Resources"));
  const xdict = res.isDictionary() ? R(res.get("XObject")) : null;
  const images = new Set<string>();
  if (xdict?.isDictionary()) {
    const keys: string[] = [];
    xdict.forEach((_v, k) => keys.push(String(k)));
    for (const k of keys) {
      const sub = R(R(xdict.get(k)).get("Subtype"));
      if (sub.isName() && sub.asName() === "Image") images.add(k);
    }
  }
  return { lp, objects: findObjects(lp.ops, images) };
}

/** Lists the images and vector paths of a page. */
export async function listPageObjects(bytes: Uint8Array, pageIndex: number): Promise<PageObject[]> {
  const { doc } = await openMupdf(bytes);
  try {
    return (await pageObjects(doc, pageIndex)).objects;
  } finally {
    doc.destroy();
  }
}

export type ObjectEdit =
  | { action: "delete" }
  | { action: "transform"; to: Rect }
  | { action: "recolor"; fill?: string; stroke?: string }
  | { action: "replace-image"; image: Uint8Array };

/** Applies an edit to one object of a page and returns the new PDF. */
export async function editPageObject(bytes: Uint8Array, pageIndex: number, objectId: string, edit: ObjectEdit): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const { doc } = await openMupdf(bytes);
  try {
    const { lp, objects } = await pageObjects(doc, pageIndex);
    const obj = objects.find((o) => o.id === objectId);
    if (!obj) throw new Error("The object was not found (the page has changed). Please try again.");
    const segment = lp.ops.slice(obj.start, obj.end + 1);
    let replacement: Operation[];
    switch (edit.action) {
      case "delete":
        replacement = [];
        break;
      case "transform": {
        const [x0, y0, x1, y1] = obj.bbox;
        const [nx0, ny0, nx1, ny1] = edit.to;
        const sx = (nx1 - nx0) / Math.max(1e-6, x1 - x0);
        const sy = (ny1 - ny0) / Math.max(1e-6, y1 - y0);
        // T maps the old bounds to the new ones in user space; insert C = CTM·T·CTM⁻¹ before the object.
        const T: Matrix = [sx, 0, 0, sy, nx0 - x0 * sx, ny0 - y0 * sy];
        const C = mul(mul(obj.ctm, T), invertMatrix(obj.ctm) as Matrix);
        replacement = [op("q"), op("cm", ...C.map((v) => num(+v.toFixed(6)))), ...segment, op("Q")];
        break;
      }
      case "recolor": {
        const pre: Operation[] = [];
        if (edit.fill) pre.push(op("rg", ...hexToRgb(edit.fill).map((v) => num(+v.toFixed(4)))));
        if (edit.stroke) pre.push(op("RG", ...hexToRgb(edit.stroke).map((v) => num(+v.toFixed(4)))));
        // Drop colour operators inside the segment (none expected) and scope the new colour.
        replacement = [op("q"), ...pre, ...segment, op("Q")];
        break;
      }
      case "replace-image": {
        if (obj.kind !== "image") throw new Error("Only images can be replaced.");
        const ref = doc.addImage(new mupdf.Image(edit.image));
        let res = lp.pageObj.get("Resources");
        if (res.isNull()) {
          res = doc.newDictionary();
          lp.pageObj.put("Resources", res);
        }
        res = R(res);
        let xo = res.get("XObject");
        if (xo.isNull()) {
          xo = doc.newDictionary();
          res.put("XObject", xo);
        }
        xo = R(xo);
        let key = "MPIM1";
        for (let k = 1; !xo.get(key).isNull(); k++) key = `MPIM${k}`;
        xo.put(key, ref);
        replacement = [op("Do", name(key))];
        if (segment[0].op === "BI") replacement = [op("Do", name(key))];
        break;
      }
    }
    const ops = [...lp.ops.slice(0, obj.start), ...replacement, ...lp.ops.slice(obj.end + 1)];
    writeContents(doc, lp.pageObj, ops);
    return saveMupdf(doc, "garbage=compact,compress");
  } finally {
    doc.destroy();
  }
}
