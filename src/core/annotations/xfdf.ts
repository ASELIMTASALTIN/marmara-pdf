import { XMLParser } from "fast-xml-parser";
import type { Annotation, AnnotationMap, Point, Rect } from "./types";
import { annotationBounds } from "./types";

/**
 * XFDF (ISO 19444-1) export/import of comments, compatible with Adobe
 * Acrobat and other PDF tools. Lets reviewers exchange comments as a small
 * file instead of sending the whole PDF.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: number) => (+v.toFixed(3)).toString();
const rectAttr = (r: Rect) => `rect="${r.map(n).join(",")}"`;

function pdfDate(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function quadCoords(rects: Rect[]): string {
  // XFDF coords: x1,y1 (upper-left), x2,y2 (upper-right), x3,y3 (lower-left), x4,y4 (lower-right)
  return rects.map((r) => [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]].map(n).join(",")).join(",");
}

export function exportXfdf(annotations: AnnotationMap, pageIds: string[], fileName: string): string {
  const items: string[] = [];
  pageIds.forEach((pid, page) => {
    for (const a of annotations[pid] ?? []) {
      const common = `page="${page}" color="${a.color}" opacity="${n(a.opacity)}" name="${esc(a.id)}" date="${pdfDate(a.createdAt)}"${a.author ? ` title="${esc(a.author)}"` : ""}`;
      const contents = (t?: string) => (t ? `<contents>${esc(t)}</contents>` : "");
      const b = annotationBounds(a);
      switch (a.type) {
        case "highlight":
        case "underline":
        case "strikeout":
          items.push(`<${a.type} ${common} ${rectAttr(b)} coords="${quadCoords(a.rects)}">${contents(a.comment ?? a.text)}</${a.type}>`);
          break;
        case "ink":
          items.push(`<ink ${common} ${rectAttr(b)} width="${n(a.width)}"><inklist>${a.paths.map((p) => `<gesture>${p.map((pt) => `${n(pt[0])},${n(pt[1])}`).join(";")}</gesture>`).join("")}</inklist>${contents(a.comment)}</ink>`);
          break;
        case "rect":
        case "ellipse": {
          const tag = a.type === "rect" ? "square" : "circle";
          items.push(`<${tag} ${common} ${rectAttr(a.rect)} width="${n(a.width)}"${a.fill ? ` interior-color="${a.fill}"` : ""}>${contents(a.comment)}</${tag}>`);
          break;
        }
        case "line":
        case "arrow":
          items.push(`<line ${common} ${rectAttr(b)} width="${n(a.width)}" start="${n(a.from[0])},${n(a.from[1])}" end="${n(a.to[0])},${n(a.to[1])}"${a.type === "arrow" ? ' head="None" tail="OpenArrow"' : ""}>${contents(a.comment)}</line>`);
          break;
        case "freetext":
          items.push(`<freetext ${common} ${rectAttr(a.rect)}><contents>${esc(a.text)}</contents><defaultappearance>/Helv ${n(a.fontSize)} Tf</defaultappearance></freetext>`);
          break;
        case "note":
          items.push(`<text ${common} ${rectAttr(b)} icon="Comment">${contents(a.text)}</text>`);
          break;
        // Images, signatures and redaction marks are not exchanged as comments.
      }
    }
  });
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n` +
    `<annots>\n${items.join("\n")}\n</annots>\n<f href="${esc(fileName)}"/>\n</xfdf>\n`
  );
}

const nums = (s?: string) => (s ?? "").split(/[,;\s]+/).filter(Boolean).map(Number);
const asRect = (s?: string): Rect | null => {
  const v = nums(s);
  return v.length >= 4 ? [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])] : null;
};
const color = (s?: string) => (s && /^#[0-9a-f]{6}$/i.test(s) ? s : "#ffd400");

function parseDate(s?: string): number {
  const m = s && /D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : Date.now();
}

/** Parses XFDF and returns annotations by 0-based page index. Unknown elements are skipped. */
export function importXfdf(xml: string, newId: () => string): { byPage: Map<number, Annotation[]>; count: number; skipped: number } {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", textNodeName: "#text", isArray: (name) => ["gesture"].includes(name) });
  const doc = parser.parse(xml);
  const annots = doc?.xfdf?.annots ?? {};
  const byPage = new Map<number, Annotation[]>();
  let count = 0;
  let skipped = 0;
  const textOf = (node: unknown): string => {
    if (!node) return "";
    if (typeof node === "string") return node;
    const c = (node as Record<string, unknown>).contents;
    if (typeof c === "string") return c;
    if (c && typeof c === "object") return String((c as Record<string, unknown>)["#text"] ?? "");
    const rc = (node as Record<string, unknown>)["contents-richtext"];
    return rc ? JSON.stringify(rc).replace(/<[^>]+>|[{}"[\]]/g, " ").replace(/\s+/g, " ").trim() : "";
  };
  for (const [tag, value] of Object.entries(annots)) {
    for (const el of (Array.isArray(value) ? value : [value]) as Record<string, string>[]) {
      if (!el || typeof el !== "object") continue;
      const page = parseInt(el.page ?? "0", 10);
      const base = {
        id: newId(),
        color: color(el.color),
        opacity: el.opacity ? Math.min(1, Math.max(0.05, parseFloat(el.opacity))) : 1,
        createdAt: parseDate(el.date ?? el.creationdate),
        author: el.title || undefined,
      };
      const rect = asRect(el.rect);
      let a: Annotation | null = null;
      switch (tag) {
        case "highlight":
        case "underline":
        case "strikeout": {
          const q = nums(el.coords);
          const rects: Rect[] = [];
          for (let i = 0; i + 7 < q.length; i += 8) {
            const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]];
            const ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]];
            rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
          }
          if (!rects.length && rect) rects.push(rect);
          if (rects.length) a = { ...base, type: tag, rects, text: textOf(el), opacity: tag === "highlight" && !el.opacity ? 0.45 : base.opacity };
          break;
        }
        case "ink": {
          const gestures = ((el as unknown as { inklist?: { gesture?: (string | { "#text": string })[] } }).inklist?.gesture ?? []).map((g) => (typeof g === "string" ? g : g["#text"]));
          const paths = gestures.map((g) => g.split(";").map((pt) => nums(pt) as Point).filter((p) => p.length === 2));
          if (paths.length) a = { ...base, type: "ink", width: parseFloat(el.width ?? "2"), paths, comment: textOf(el) || undefined };
          break;
        }
        case "square":
        case "circle":
          if (rect) a = { ...base, type: tag === "square" ? "rect" : "ellipse", rect, width: parseFloat(el.width ?? "1"), fill: el["interior-color"] ?? null, comment: textOf(el) || undefined };
          break;
        case "line": {
          const s = nums(el.start);
          const e = nums(el.end);
          if (s.length === 2 && e.length === 2) {
            const arrow = /arrow/i.test(el.tail ?? "") || /arrow/i.test(el.head ?? "");
            a = { ...base, type: arrow ? "arrow" : "line", from: [s[0], s[1]], to: [e[0], e[1]], width: parseFloat(el.width ?? "1") };
          }
          break;
        }
        case "freetext": {
          const da = (el as unknown as { defaultappearance?: string }).defaultappearance ?? "";
          const size = parseFloat(/([\d.]+)\s+Tf/.exec(String(da))?.[1] ?? "12");
          if (rect) a = { ...base, type: "freetext", rect, text: textOf(el), fontSize: size, color: el.color ? base.color : "#1f2328" };
          break;
        }
        case "text":
          if (rect) a = { ...base, type: "note", point: [rect[0], rect[3]], text: textOf(el), color: el.color ? base.color : "#ffd02f" };
          break;
      }
      if (a) {
        byPage.set(page, [...(byPage.get(page) ?? []), a]);
        count++;
      } else skipped++;
    }
  }
  return { byPage, count, skipped };
}
