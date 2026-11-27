import { openMupdf, saveMupdf } from "../mupdf/loader";

type PDFObject = import("mupdf").PDFObject;
type MDoc = import("mupdf").PDFDocument;

export interface OutlineNode {
  id: string;
  title: string;
  /** 0-based target page, -1 if none. */
  page: number;
  open: boolean;
  children: OutlineNode[];
}

let seq = 0;
const nid = () => `o${++seq}`;

/** Reads the bookmark tree. */
export async function readOutline(bytes: Uint8Array): Promise<OutlineNode[]> {
  const { doc } = await openMupdf(bytes);
  try {
    const items = doc.loadOutline() ?? [];
    const conv = (list: NonNullable<ReturnType<MDoc["loadOutline"]>>): OutlineNode[] =>
      list.map((i) => ({
        id: nid(),
        title: i.title ?? "",
        page: typeof i.page === "number" ? i.page : i.uri ? safeResolve(doc, i.uri) : -1,
        open: !!i.open,
        children: i.down ? conv(i.down) : [],
      }));
    return conv(items);
  } finally {
    doc.destroy();
  }
}

function safeResolve(doc: MDoc, uri: string): number {
  try {
    return doc.resolveLink(uri);
  } catch {
    return -1;
  }
}

function countVisible(nodes: OutlineNode[]): number {
  return nodes.reduce((n, x) => n + 1 + (x.open ? countVisible(x.children) : 0), 0);
}

/** Replaces the document's bookmarks with the given tree. */
export async function writeOutline(bytes: Uint8Array, nodes: OutlineNode[]): Promise<Uint8Array> {
  const { doc } = await openMupdf(bytes);
  try {
    const root = doc.getTrailer().get("Root").resolve();
    root.delete("Outlines");
    if (nodes.length) {
      const outlines = doc.addObject(doc.newDictionary());
      outlines.resolve().put("Type", doc.newName("Outlines"));
      const nPages = doc.countPages();
      const build = (list: OutlineNode[], parent: PDFObject) => {
        const refs = list.map(() => doc.addObject(doc.newDictionary()));
        list.forEach((node, i) => {
          const d = refs[i].resolve();
          d.put("Title", doc.newString(node.title || "Untitled"));
          d.put("Parent", parent);
          if (i > 0) d.put("Prev", refs[i - 1]);
          if (i < list.length - 1) d.put("Next", refs[i + 1]);
          if (node.page >= 0 && node.page < nPages) {
            const dest = doc.newArray();
            dest.push(doc.findPage(node.page));
            dest.push(doc.newName("Fit"));
            d.put("Dest", dest);
          }
          if (node.children.length) {
            const kids = build(node.children, refs[i]);
            d.put("First", kids[0]);
            d.put("Last", kids[kids.length - 1]);
            const c = countVisible(node.children);
            d.put("Count", node.open ? c : -c);
          }
        });
        return refs;
      };
      const top = build(nodes, outlines);
      const o = outlines.resolve();
      o.put("First", top[0]);
      o.put("Last", top[top.length - 1]);
      o.put("Count", countVisible(nodes));
      root.put("Outlines", outlines);
    }
    return saveMupdf(doc, "garbage=compact,compress");
  } finally {
    doc.destroy();
  }
}

// --- pure tree helpers (used by the editor UI) ------------------------------------

export function findPath(nodes: OutlineNode[], id: string, path: number[] = []): number[] | null {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return [...path, i];
    const p = findPath(nodes[i].children, id, [...path, i]);
    if (p) return p;
  }
  return null;
}

function clone(nodes: OutlineNode[]): OutlineNode[] {
  return nodes.map((n) => ({ ...n, children: clone(n.children) }));
}

function siblingsAt(nodes: OutlineNode[], path: number[]): OutlineNode[] {
  let list = nodes;
  for (const i of path.slice(0, -1)) list = list[i].children;
  return list;
}

export function updateNode(nodes: OutlineNode[], id: string, patch: Partial<OutlineNode>): OutlineNode[] {
  const out = clone(nodes);
  const p = findPath(out, id);
  if (!p) return nodes;
  const list = siblingsAt(out, p);
  list[p[p.length - 1]] = { ...list[p[p.length - 1]], ...patch };
  return out;
}

export function removeNode(nodes: OutlineNode[], id: string): OutlineNode[] {
  const out = clone(nodes);
  const p = findPath(out, id);
  if (!p) return nodes;
  siblingsAt(out, p).splice(p[p.length - 1], 1);
  return out;
}

/** Inserts after `afterId` (same level) or at the end of the top level. */
export function insertNode(nodes: OutlineNode[], node: Omit<OutlineNode, "id">, afterId?: string): OutlineNode[] {
  const out = clone(nodes);
  const n = { ...node, id: nid() };
  const p = afterId ? findPath(out, afterId) : null;
  if (!p) out.push(n);
  else siblingsAt(out, p).splice(p[p.length - 1] + 1, 0, n);
  return out;
}

export function moveNode(nodes: OutlineNode[], id: string, dir: "up" | "down" | "in" | "out"): OutlineNode[] {
  const out = clone(nodes);
  const p = findPath(out, id);
  if (!p) return nodes;
  const list = siblingsAt(out, p);
  const i = p[p.length - 1];
  const [node] = list.splice(i, 1);
  if (dir === "up" && i > 0) list.splice(i - 1, 0, node);
  else if (dir === "down" && i < list.length) list.splice(i + 1, 0, node);
  else if (dir === "in" && i > 0) {
    list[i - 1].children.push(node);
    list[i - 1].open = true;
  } else if (dir === "out" && p.length > 1) {
    const parentList = siblingsAt(out, p.slice(0, -1));
    parentList.splice(p[p.length - 2] + 1, 0, node);
  } else list.splice(i, 0, node);
  return out;
}
