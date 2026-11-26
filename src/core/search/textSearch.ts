/**
 * Plain-text search over pdf.js text content.
 *
 * pdf.js creates one text-layer <span> per text item (items that carry `str`),
 * so a match expressed as (itemIndex, offset) maps directly onto the rendered
 * text layer for highlighting.
 */

export interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
  height?: number;
}

export interface PageText {
  /** Folded (case/diacritic-normalised) text, same length as the raw text. */
  folded: string;
  raw: string;
  /** Start offset of each text item within `raw`. */
  itemStarts: number[];
  itemLengths: number[];
}

export interface SearchOptions {
  matchCase: boolean;
  wholeWord: boolean;
}

export interface TextRange {
  start: number;
  end: number;
}

export interface ItemSegment {
  item: number;
  from: number;
  to: number;
}

const SPECIAL_FOLD: Record<string, string> = {
  ı: "i",
  İ: "i",
  I: "i",
  ß: "ß",
  " ": " ",
  "\t": " ",
  "\n": " ",
  "\r": " ",
  "ﬁ": "ﬁ",
};

/** Maps a single char to a single comparable char (keeps offsets stable). */
export function foldChar(c: string, matchCase: boolean): string {
  if (!matchCase) {
    const s = SPECIAL_FOLD[c];
    if (s) return s;
  } else if (/\s/.test(c)) {
    return " ";
  }
  let out = matchCase ? c : c.toLowerCase();
  if (out.length !== 1) out = c;
  // Strip diacritics: ö→o, ğ→g, ç→c, é→e …
  const base = out.normalize("NFD");
  if (base.length > 1 && /^[̀-ͯ]+$/.test(base.slice(1))) out = base[0];
  return out;
}

export function foldString(s: string, matchCase: boolean): string {
  let out = "";
  for (const c of s) {
    // Astral chars (surrogate pairs) are kept as-is to preserve UTF-16 offsets.
    out += c.length === 1 ? foldChar(c, matchCase) : c;
  }
  return out;
}

export function buildPageText(items: TextItemLike[], matchCase = false): PageText {
  let raw = "";
  const itemStarts: number[] = [];
  const itemLengths: number[] = [];
  let prev: TextItemLike | null = null;
  for (const it of items) {
    if (typeof it.str !== "string") continue; // marked-content markers have no span
    // Items on the same line separated by a visible gap are separate words.
    if (prev && needsSeparator(prev, it) && raw && !/\s$/.test(raw) && !/^\s/.test(it.str)) raw += " ";
    if (it.str) prev = it;
    itemStarts.push(raw.length);
    itemLengths.push(it.str.length);
    raw += it.str;
    if (it.hasEOL) raw += " ";
  }
  return { raw, folded: foldString(raw, matchCase), itemStarts, itemLengths };
}

function needsSeparator(a: TextItemLike, b: TextItemLike): boolean {
  if (a.hasEOL || !a.transform || !b.transform || !b.str) return false;
  const h = Math.max(Math.abs(a.height ?? 0), Math.abs(a.transform[3]), 1);
  const sameLine = Math.abs(a.transform[5] - b.transform[5]) < h * 0.5;
  const gap = b.transform[4] - (a.transform[4] + (a.width ?? 0));
  return sameLine && gap > h * 0.15;
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);

export function findInPage(page: PageText, query: string, opts: SearchOptions): TextRange[] {
  const q = foldString(query, opts.matchCase).replace(/\s+/g, " ").trim();
  if (!q) return [];
  const hay = opts.matchCase ? foldString(page.raw, true) : page.folded;
  const out: TextRange[] = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(q, from);
    if (i < 0) break;
    const end = i + q.length;
    if (!opts.wholeWord || (!isWordChar(hay[i - 1]) && !isWordChar(hay[end]))) out.push({ start: i, end });
    from = i + Math.max(1, q.length);
  }
  return out;
}

/** Splits a text range into per-item segments (for highlighting spans). */
export function rangeToSegments(page: PageText, range: TextRange): ItemSegment[] {
  const segs: ItemSegment[] = [];
  const { itemStarts, itemLengths } = page;
  // binary search for the first item that ends after range.start
  let lo = 0;
  let hi = itemStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (itemStarts[mid] + itemLengths[mid] <= range.start) lo = mid + 1;
    else hi = mid;
  }
  for (let k = lo; k < itemStarts.length && itemStarts[k] < range.end; k++) {
    const from = Math.max(range.start, itemStarts[k]) - itemStarts[k];
    const to = Math.min(range.end, itemStarts[k] + itemLengths[k]) - itemStarts[k];
    if (to > from) segs.push({ item: k, from, to });
  }
  return segs;
}
