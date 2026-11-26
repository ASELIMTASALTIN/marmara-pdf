import { glyphNameToUnicode } from "./glyphNames";

type PDFObject = import("mupdf").PDFObject;
/** Null-safe resolve: MuPDF's shared Null object cannot be resolved. */
const R = (o: PDFObject): PDFObject => (o.isNull() ? o : o.resolve());

type MuPDF = typeof import("mupdf");

/**
 * Decoding/encoding information for one PDF font resource: maps character
 * codes to Unicode (and back) and provides glyph widths, so text-showing
 * operators can be decoded, measured and re-encoded.
 */
export interface FontInfo {
  /** Resource name, e.g. "F1". */
  key: string;
  baseFont: string;
  subtype: string;
  /** Bytes per character code: 1 for simple fonts, 2 for Identity-H CID fonts. */
  bytesPerCode: 1 | 2;
  isSubset: boolean;
  embedded: boolean;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  /** False when codes cannot be reliably decoded (e.g. Type3, unknown CMaps). */
  editable: boolean;
  toUnicode: Map<number, string>;
  fromUnicode: Map<string, number>;
  /** Codes seen in the page content (glyphs known to exist in a subset font). */
  usedCodes: Set<number>;
  /** The font's PDF object (to reference it from other resource dictionaries). */
  ref?: unknown;
  /** Object number of the font dictionary (-1 if direct); identical fonts may use different resource keys. */
  objNum: number;
  /** Codes whose glyph is known to exist (Type3: glyph procedures present). Overrides subset heuristics. */
  available?: Set<number>;
  /** Width in 1/1000 text-space units. */
  width(code: number): number;
  ascent: number;
  descent: number;
}

const WIN_ANSI = (() => {
  const d = new TextDecoder("windows-1252");
  const m = new Map<number, string>();
  for (let c = 0x20; c < 256; c++) {
    const s = d.decode(Uint8Array.of(c));
    if (s !== "�") m.set(c, s);
  }
  return m;
})();
const MAC_ROMAN = (() => {
  const m = new Map<number, string>();
  try {
    const d = new TextDecoder("macintosh");
    for (let c = 0x20; c < 256; c++) m.set(c, d.decode(Uint8Array.of(c)));
  } catch {
    for (let c = 0x20; c < 0x7f; c++) m.set(c, String.fromCharCode(c));
  }
  return m;
})();
const STANDARD = (() => {
  const m = new Map<number, string>();
  for (let c = 0x20; c < 0x7f; c++) m.set(c, String.fromCharCode(c));
  m.set(0x27, "’");
  m.set(0x60, "‘");
  const hi: Record<number, string> = {
    0xa1: "¡", 0xa2: "¢", 0xa3: "£", 0xa4: "⁄", 0xa5: "¥", 0xa6: "ƒ", 0xa7: "§", 0xa8: "¤", 0xa9: "'", 0xaa: "“", 0xab: "«",
    0xac: "‹", 0xad: "›", 0xae: "ﬁ", 0xaf: "ﬂ", 0xb1: "–", 0xb2: "†", 0xb3: "‡", 0xb4: "·", 0xb6: "¶", 0xb7: "•", 0xb8: "‚",
    0xb9: "„", 0xba: "”", 0xbb: "»", 0xbc: "…", 0xbd: "‰", 0xbf: "¿", 0xc1: "`", 0xc2: "´", 0xc3: "ˆ", 0xc4: "˜", 0xc5: "¯",
    0xc6: "˘", 0xc7: "˙", 0xc8: "¨", 0xca: "˚", 0xcb: "¸", 0xcd: "˝", 0xce: "˛", 0xcf: "ˇ", 0xd0: "—", 0xe1: "Æ", 0xe3: "ª",
    0xe8: "Ł", 0xe9: "Ø", 0xea: "Œ", 0xeb: "º", 0xf1: "æ", 0xf5: "ı", 0xf8: "ł", 0xf9: "ø", 0xfa: "œ", 0xfb: "ß",
  };
  for (const [k, v] of Object.entries(hi)) m.set(+k, v);
  return m;
})();

function baseEncoding(name: string | null, symbolic: boolean): Map<number, string> {
  if (name === "WinAnsiEncoding") return new Map(WIN_ANSI);
  if (name === "MacRomanEncoding") return new Map(MAC_ROMAN);
  if (name === "StandardEncoding") return new Map(STANDARD);
  // No encoding given: non-symbolic fonts default to StandardEncoding.
  return symbolic ? new Map() : new Map(STANDARD);
}

// --- ToUnicode CMap ------------------------------------------------------------
function hexToBytes(h: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.substr(i, 2).padEnd(2, "0"), 16));
  return out;
}
function bytesToCode(b: number[]): number {
  return b.reduce((v, x) => v * 256 + x, 0);
}
function utf16beToString(b: number[]): string {
  let s = "";
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  if (b.length % 2) s += String.fromCharCode(b[b.length - 1]);
  return s;
}

export function parseToUnicode(text: string): { map: Map<number, string>; codeBytes: number } {
  const map = new Map<number, string>();
  let codeBytes = 0;
  const cs = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  let m: RegExpExecArray | null;
  while ((m = cs.exec(text))) {
    const hexes = m[1].match(/<([0-9a-fA-F]+)>/g) ?? [];
    if (hexes.length) codeBytes = Math.max(codeBytes, Math.ceil(hexes[0]!.replace(/[<>]/g, "").length / 2));
  }
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bfchar.exec(text))) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g;
    let p: RegExpExecArray | null;
    while ((p = re.exec(m[1]))) {
      map.set(bytesToCode(hexToBytes(p[1])), utf16beToString(hexToBytes(p[2])));
      codeBytes ||= Math.ceil(p[1].length / 2);
    }
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(text))) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]*)>|\[([^\]]*)\])/g;
    let p: RegExpExecArray | null;
    while ((p = re.exec(m[1]))) {
      const lo = bytesToCode(hexToBytes(p[1]));
      const hi = bytesToCode(hexToBytes(p[2]));
      codeBytes ||= Math.ceil(p[1].length / 2);
      if (hi - lo > 65535) continue;
      if (p[4] !== undefined) {
        const dst = hexToBytes(p[4]);
        for (let c = lo; c <= hi; c++) {
          const d = [...dst];
          // increment the last byte (carrying)
          let add = c - lo;
          for (let i = d.length - 1; i >= 0 && add > 0; i--) {
            const v = d[i] + add;
            d[i] = v & 0xff;
            add = v >> 8;
          }
          map.set(c, utf16beToString(d));
        }
      } else {
        const items = p[5].match(/<([0-9a-fA-F]*)>/g) ?? [];
        items.forEach((it, k) => map.set(lo + k, utf16beToString(hexToBytes(it.replace(/[<>]/g, "")))));
      }
    }
  }
  return { map, codeBytes };
}

// --- MuPDF object helpers --------------------------------------------------------
const nameOf = (o: PDFObject | undefined | null): string | null => (o && o.isName() ? o.asName() : null);
const numOf = (o: PDFObject | undefined | null, d = 0): number => (o && o.isNumber() ? o.asNumber() : d);

function readStreamText(o: PDFObject): string | null {
  try {
    if (!o.isStream()) return null; // must be the indirect reference, not resolved
    const buf = o.readStream();
    const bytes = buf.asUint8Array();
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    buf.destroy?.();
    return s;
  } catch {
    return null;
  }
}

/** Builds FontInfo for a /Font resource entry. */
export function loadFontInfo(mupdf: MuPDF, key: string, fontObj: PDFObject): FontInfo {
  const f = R(fontObj);
  const subtype = nameOf(f.get("Subtype")) ?? "Type1";
  const baseFont = nameOf(f.get("BaseFont")) ?? key;
  const isCID = subtype === "Type0";
  const descendant = isCID ? R(R(f.get("DescendantFonts")).get(0)) : null;
  const desc = R(isCID ? descendant!.get("FontDescriptor") : f.get("FontDescriptor"));
  const flags = desc.isDictionary() ? numOf(desc.get("Flags")) : 0;
  const embedded = desc.isDictionary() && ["FontFile", "FontFile2", "FontFile3"].some((k) => !desc.get(k).isNull());
  const symbolic = !!(flags & 4);
  const lname = baseFont.toLowerCase();
  const bold = /bold|black|heavy|semibold|demi/.test(lname) || !!(flags & (1 << 18)) || numOf(desc.isDictionary() ? desc.get("FontWeight") : null) >= 600;
  const italic = /italic|oblique/.test(lname) || !!(flags & 64);
  const mono = /courier|mono|consol/.test(lname) || !!(flags & 1);
  const serif = !mono && (/times|serif|roman|georgia|garamond|cambria|book|minion|palatino/.test(lname) || (!!(flags & 2) && !/sans|arial|helvet/.test(lname)));
  const ascent = desc.isDictionary() ? numOf(desc.get("Ascent"), 800) : 800;
  const descent = desc.isDictionary() ? numOf(desc.get("Descent"), -200) : -200;

  let toUnicode = new Map<number, string>();
  let bytesPerCode: 1 | 2 = isCID ? 2 : 1;
  const isType3 = subtype === "Type3";
  const type3Available = new Set<number>();
  let editable = true;

  const tu = f.get("ToUnicode");
  if (!tu.isNull()) {
    const text = readStreamText(tu);
    if (text) {
      const parsed = parseToUnicode(text);
      toUnicode = parsed.map;
    }
  }

  if (isCID) {
    const enc = nameOf(f.get("Encoding"));
    if (enc !== "Identity-H" && enc !== "Identity-V") {
      // Other CMaps (CJK predefined or embedded): only editable when we can map codes 1:1 via ToUnicode.
      editable = editable && toUnicode.size > 0;
    }
    if (!toUnicode.size) editable = false;
  } else {
    const encObj = R(f.get("Encoding"));
    let base: string | null = null;
    let differences: PDFObject | null = null;
    if (encObj.isName()) base = encObj.asName();
    else if (encObj.isDictionary()) {
      base = nameOf(encObj.get("BaseEncoding"));
      if (!encObj.get("Differences").isNull()) differences = encObj.get("Differences");
    }
    const encMap = baseEncoding(base, symbolic && !base);
    if (differences) {
      let code = 0;
      for (let i = 0; i < differences.length; i++) {
        const item = differences.get(i);
        if (item.isNumber()) code = item.asNumber();
        else if (item.isName()) {
          const u = glyphNameToUnicode(item.asName());
          if (u) encMap.set(code, u);
          else encMap.delete(code);
          code++;
        }
      }
    }
    // ToUnicode wins where present; encoding fills the rest.
    for (const [c, u] of encMap) if (!toUnicode.has(c)) toUnicode.set(c, u);
    if (isType3 && differences) {
      // Type3 glyphs are procedures named by /Differences; a code is drawable if its procedure exists.
      const procs = R(f.get("CharProcs"));
      let code = 0;
      for (let i = 0; i < differences.length; i++) {
        const item = differences.get(i);
        if (item.isNumber()) code = item.asNumber();
        else if (item.isName()) {
          if (procs.isDictionary() && !procs.get(item.asName()).isNull()) type3Available.add(code);
          code++;
        }
      }
    }
    if (!toUnicode.size) editable = false;
    bytesPerCode = 1;
  }

  const type3Box = (() => {
    if (!isType3) return null;
    const bb = R(f.get("FontBBox"));
    if (!bb.isArray() || bb.length < 4) return null;
    const v = [0, 1, 2, 3].map((k) => numOf(bb.get(k)));
    return v[3] - v[1] > 0 ? v : null;
  })();
  const fromUnicode = new Map<string, number>();
  for (const [code, u] of toUnicode) if (u && !fromUnicode.has(u)) fromUnicode.set(u, code);

  // --- widths ---
  let width: (code: number) => number;
  // Type3 widths and bounding box are in glyph space; FontMatrix maps them to text space.
  const fm = isType3 ? R(f.get("FontMatrix")) : null;
  const fmScale = fm?.isArray() ? numOf(fm.get(0), 0.001) : 0.001;
  const fmScaleY = fm?.isArray() ? numOf(fm.get(3), 0.001) : 0.001;
  if (isCID) {
    const dw = numOf(descendant!.get("DW"), 1000);
    const wmap = new Map<number, number>();
    const W = R(descendant!.get("W"));
    if (W.isArray()) {
      for (let i = 0; i < W.length; ) {
        const first = W.get(i).asNumber();
        const next = R(W.get(i + 1));
        if (next.isArray()) {
          for (let k = 0; k < next.length; k++) wmap.set(first + k, next.get(k).asNumber());
          i += 2;
        } else {
          const last = next.asNumber();
          const w = W.get(i + 2).asNumber();
          for (let c = first; c <= last && c - first < 65536; c++) wmap.set(c, w);
          i += 3;
        }
      }
    }
    width = (c) => wmap.get(c) ?? dw;
  } else {
    const first = numOf(f.get("FirstChar"), 0);
    const Wd = R(f.get("Widths"));
    const widths: number[] = [];
    if (Wd.isArray()) for (let i = 0; i < Wd.length; i++) widths.push(numOf(R(Wd.get(i))));
    const missing = desc.isDictionary() ? numOf(desc.get("MissingWidth"), 0) : 0;
    let builtin: import("mupdf").Font | null = null;
    if (!widths.length) {
      try {
        builtin = new mupdf.Font(baseFont.replace(/^[A-Z]{6}\+/, ""));
      } catch {
        builtin = null;
      }
    }
    width = (c) => {
      const raw = widths[c - first];
      const w = raw !== undefined && isType3 ? (raw * fmScale) / 0.001 : raw;
      if (w !== undefined && w > 0) return w;
      if (builtin) {
        const u = toUnicode.get(c);
        if (u) {
          const gid = builtin.encodeCharacter(u.codePointAt(0)!);
          if (gid > 0) return builtin.advanceGlyph(gid) * 1000;
        }
      }
      return w ?? (missing || 500);
    };
  }

  return {
    key,
    baseFont,
    subtype,
    bytesPerCode,
    isSubset: /^[A-Z]{6}\+/.test(baseFont),
    embedded,
    bold,
    italic,
    serif,
    mono,
    editable,
    toUnicode,
    fromUnicode,
    usedCodes: new Set(),
    available: isType3 ? type3Available : undefined,
    ref: fontObj,
    objNum: fontObj.isIndirect() ? fontObj.asIndirect() : -1,
    width,
    ascent: type3Box ? (type3Box[3] * fmScaleY) / 0.001 : ascent || 800,
    descent: type3Box ? (type3Box[1] * fmScaleY) / 0.001 : descent || -200,
  };
}

/** True when two font resources refer to the same font. */
export function sameFont(a: FontInfo, b: FontInfo): boolean {
  return a === b || (a.objNum > 0 && a.objNum === b.objNum);
}

export function decodeCodes(font: FontInfo, bytes: Uint8Array): number[] {
  const codes: number[] = [];
  if (font.bytesPerCode === 2) for (let i = 0; i + 1 < bytes.length; i += 2) codes.push((bytes[i] << 8) | bytes[i + 1]);
  else for (const b of bytes) codes.push(b);
  return codes;
}

export function codesToText(font: FontInfo, codes: number[]): string {
  return codes.map((c) => font.toUnicode.get(c) ?? "�").join("");
}

/**
 * Encodes text in a font's own encoding. Returns null when a character has no
 * code, or (for subset fonts) its glyph is not known to be embedded.
 * Spaces without a glyph become `missingSpaces` positions (rendered as kerning).
 */
export function encodeText(font: FontInfo, text: string): { codes: number[]; spaceGaps: number[] } | null {
  const codes: number[] = [];
  const spaceGaps: number[] = [];
  for (const ch of Array.from(text)) {
    const code = font.fromUnicode.get(ch);
    const known =
      code !== undefined &&
      (font.available
        ? font.available.has(code)
        : !font.isSubset || font.usedCodes.has(code) || (font.bytesPerCode === 2 && font.toUnicode.has(code)));
    if (!known) {
      if (ch === " ") {
        spaceGaps.push(codes.length);
        continue;
      }
      return null;
    }
    codes.push(code!);
  }
  return { codes, spaceGaps };
}

export function codesToBytes(font: FontInfo, codes: number[]): Uint8Array {
  if (font.bytesPerCode === 2) {
    const out = new Uint8Array(codes.length * 2);
    codes.forEach((c, i) => {
      out[2 * i] = (c >> 8) & 0xff;
      out[2 * i + 1] = c & 0xff;
    });
    return out;
  }
  return Uint8Array.from(codes);
}
