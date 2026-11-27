import type { Rect } from "../annotations/types";
import { invertMatrix, openMupdf, transformPoint, type Matrix } from "../mupdf/loader";

export interface Word {
  text: string;
  page: number;
  /** PDF user-space bounds. */
  rect: Rect;
}

export interface Change {
  kind: "inserted" | "deleted";
  text: string;
  /** Words in the document where the change is visible (new doc for insertions, old doc for deletions). */
  words: Word[];
  /** For deletions: where in the *new* document the text used to be (page + anchor point). */
  anchor?: { page: number; point: [number, number] };
}

export interface CompareResult {
  changes: Change[];
  insertedWords: number;
  deletedWords: number;
  pagesA: number;
  pagesB: number;
}

/** Extracts words with positions (PDF user space) from every page. */
export async function extractWords(bytes: Uint8Array): Promise<{ words: Word[]; pages: number }> {
  const { doc } = await openMupdf(bytes);
  try {
    const words: Word[] = [];
    const n = doc.countPages();
    for (let p = 0; p < n; p++) {
      const page = doc.loadPage(p) as import("mupdf").PDFPage;
      const inv = invertMatrix(page.getTransform() as Matrix);
      let cur = "";
      let box: number[] | null = null;
      const flush = () => {
        if (cur.trim() && box) {
          const a = transformPoint(inv, box[0], box[1]);
          const b = transformPoint(inv, box[2], box[3]);
          words.push({ text: cur, page: p, rect: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] });
        }
        cur = "";
        box = null;
      };
      const st = page.toStructuredText("preserve-whitespace");
      st.walk({
        onChar(c: string, _o: unknown, _f: unknown, _s: number, quad: number[]) {
          if (/\s/.test(c)) {
            flush();
            return;
          }
          const xs = [quad[0], quad[2], quad[4], quad[6]];
          const ys = [quad[1], quad[3], quad[5], quad[7]];
          const r = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
          box = box ? [Math.min(box[0], r[0]), Math.min(box[1], r[1]), Math.max(box[2], r[2]), Math.max(box[3], r[3])] : r;
          cur += c;
        },
        endLine: flush,
      } as never);
      flush();
      st.destroy?.();
    }
    return { words, pages: n };
  } finally {
    doc.destroy();
  }
}

type Op = { t: "eq" | "ins" | "del"; a?: number; b?: number };

/** Myers O((N+M)·D) diff over token arrays. */
export function diffTokens(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? v.get(k + 1) ?? 0 : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
    if (d > 20000) break; // pathological inputs: give up gracefully
  }
  // backtrack
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && (vv.get(k - 1) ?? -1) < (vv.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevX = vv.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push({ t: "eq", a: --x, b: --y });
    if (d > 0) {
      if (x === prevX) ops.push({ t: "ins", b: --y });
      else ops.push({ t: "del", a: --x });
    }
  }
  return ops.reverse();
}

const norm = (w: string) => w.normalize("NFC");

/** Compares the text of two PDFs word by word. */
export async function compareDocuments(oldBytes: Uint8Array, newBytes: Uint8Array): Promise<CompareResult> {
  const A = await extractWords(oldBytes);
  const B = await extractWords(newBytes);
  const ops = diffTokens(A.words.map((w) => norm(w.text)), B.words.map((w) => norm(w.text)));
  const changes: Change[] = [];
  let lastB: Word | null = null;
  for (const o of ops) {
    if (o.t === "eq") {
      lastB = B.words[o.b!];
      continue;
    }
    const kind = o.t === "ins" ? "inserted" : "deleted";
    const word = o.t === "ins" ? B.words[o.b!] : A.words[o.a!];
    const prev = changes[changes.length - 1];
    if (prev && prev.kind === kind && prev.words[prev.words.length - 1].page === word.page) {
      prev.words.push(word);
      prev.text += " " + word.text;
    } else {
      const c: Change = { kind, text: word.text, words: [word] };
      if (kind === "deleted") {
        const ref = lastB ?? B.words[0];
        c.anchor = ref ? { page: ref.page, point: [ref.rect[2], ref.rect[3]] } : { page: 0, point: [20, 20] };
      }
      changes.push(c);
    }
    if (o.t === "ins") lastB = word;
  }
  return {
    changes,
    insertedWords: ops.filter((o) => o.t === "ins").length,
    deletedWords: ops.filter((o) => o.t === "del").length,
    pagesA: A.pages,
    pagesB: B.pages,
  };
}
