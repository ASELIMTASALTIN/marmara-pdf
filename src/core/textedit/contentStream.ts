/**
 * PDF content-stream lexer, parser and serializer (ISO 32000-1 §7.8.2).
 *
 * Parses a content stream into a flat list of operations (operands + operator)
 * while keeping inline images verbatim, so the stream can be modified at the
 * operator level and written back without disturbing anything else.
 */

export type PdfValue =
  | { t: "num"; v: number; raw?: string }
  | { t: "name"; v: string }
  | { t: "str"; v: Uint8Array; hex: boolean }
  | { t: "arr"; v: PdfValue[] }
  | { t: "dict"; v: Map<string, PdfValue> }
  | { t: "bool"; v: boolean }
  | { t: "null" };

export interface Operation {
  op: string;
  operands: PdfValue[];
  /** Raw bytes for inline images (BI … ID … EI), emitted verbatim. */
  raw?: Uint8Array;
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

class Lexer {
  pos = 0;
  constructor(readonly b: Uint8Array) {}

  skipWs() {
    const b = this.b;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) {
        // comment until EOL
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  readRegular(): string {
    const start = this.pos;
    const b = this.b;
    while (this.pos < b.length && !WS.has(b[this.pos]) && !DELIM.has(b[this.pos])) this.pos++;
    let s = "";
    for (let i = start; i < this.pos; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  readLiteralString(): Uint8Array {
    const b = this.b;
    this.pos++; // (
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x5c) {
        const n = b[this.pos++];
        switch (n) {
          case 0x6e: out.push(0x0a); break; // n
          case 0x72: out.push(0x0d); break; // r
          case 0x74: out.push(0x09); break; // t
          case 0x62: out.push(0x08); break; // b
          case 0x66: out.push(0x0c); break; // f
          case 0x0d: if (b[this.pos] === 0x0a) this.pos++; break; // line continuation
          case 0x0a: break;
          default:
            if (n >= 0x30 && n <= 0x37) {
              let v = n - 0x30;
              for (let k = 0; k < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; k++) v = v * 8 + (b[this.pos++] - 0x30);
              out.push(v & 0xff);
            } else out.push(n);
        }
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return Uint8Array.from(out);
  }

  readHexString(): Uint8Array {
    const b = this.b;
    this.pos++; // <
    const digits: number[] = [];
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const c = b[this.pos++];
      const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
      if (v >= 0) digits.push(v);
    }
    this.pos++; // >
    if (digits.length % 2) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = digits[2 * i] * 16 + digits[2 * i + 1];
    return out;
  }

  /** Reads one object, or an operator keyword (returned as { op }). */
  next(): PdfValue | { op: string } | null {
    this.skipWs();
    const b = this.b;
    if (this.pos >= b.length) return null;
    const c = b[this.pos];
    if (c === 0x2f) {
      this.pos++;
      const raw = this.readRegular();
      return { t: "name", v: raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) };
    }
    if (c === 0x28) return { t: "str", v: this.readLiteralString(), hex: false };
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        const map = new Map<string, PdfValue>();
        for (;;) {
          this.skipWs();
          if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) {
            this.pos += 2;
            break;
          }
          const k = this.next();
          if (!k) break;
          const v = this.next();
          if (k && "t" in k && k.t === "name" && v && "t" in v) map.set(k.v, v);
        }
        return { t: "dict", v: map };
      }
      return { t: "str", v: this.readHexString(), hex: true };
    }
    if (c === 0x5b) {
      this.pos++;
      const arr: PdfValue[] = [];
      for (;;) {
        this.skipWs();
        if (b[this.pos] === 0x5d) {
          this.pos++;
          break;
        }
        const v = this.next();
        if (!v) break;
        if ("t" in v) arr.push(v);
      }
      return { t: "arr", v: arr };
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      this.pos++; // stray delimiter: ignore
      return this.next();
    }
    const word = this.readRegular();
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: "num", v: parseFloat(word), raw: word };
    if (word === "true" || word === "false") return { t: "bool", v: word === "true" };
    if (word === "null") return { t: "null" };
    return { op: word };
  }

  /** After "ID", skip binary image data up to the matching "EI". */
  readInlineImageData(): number {
    const b = this.b;
    if (WS.has(b[this.pos])) this.pos++;
    const start = this.pos;
    while (this.pos < b.length - 1) {
      if (
        b[this.pos] === 0x45 &&
        b[this.pos + 1] === 0x49 &&
        WS.has(b[this.pos - 1]) &&
        (this.pos + 2 >= b.length || WS.has(b[this.pos + 2]) || DELIM.has(b[this.pos + 2]))
      ) {
        this.pos += 2;
        return start;
      }
      this.pos++;
    }
    this.pos = b.length;
    return start;
  }
}

export function parseContentStream(bytes: Uint8Array): Operation[] {
  const lx = new Lexer(bytes);
  const ops: Operation[] = [];
  let operands: PdfValue[] = [];
  for (;;) {
    const startPos = lx.pos;
    const tok = lx.next();
    if (!tok) break;
    if ("op" in tok) {
      if (tok.op === "BI") {
        // Inline image: keep BI … EI verbatim.
        let biStart = startPos;
        while (biStart < bytes.length && bytes[biStart] !== 0x42) biStart++;
        for (;;) {
          const t = lx.next();
          if (!t || ("op" in t && t.op === "ID")) break;
        }
        lx.readInlineImageData();
        ops.push({ op: "BI", operands: [], raw: bytes.slice(biStart, lx.pos) });
        operands = [];
        continue;
      }
      ops.push({ op: tok.op, operands });
      operands = [];
    } else operands.push(tok);
  }
  return ops;
}

// --- serializer -----------------------------------------------------------------
function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

function escapeName(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c < 0x21 || c > 0x7e || "()<>[]{}/%#".includes(ch) ? "#" + c.toString(16).padStart(2, "0") : ch;
  }
  return out;
}

export function serializeValue(v: PdfValue): string {
  switch (v.t) {
    case "num":
      return v.raw ?? fmtNum(v.v);
    case "name":
      return "/" + escapeName(v.v);
    case "str": {
      let h = "";
      for (const b of v.v) h += b.toString(16).padStart(2, "0");
      return `<${h}>`;
    }
    case "arr":
      return "[" + v.v.map(serializeValue).join(" ") + "]";
    case "dict":
      return "<<" + [...v.v].map(([k, val]) => `/${escapeName(k)} ${serializeValue(val)}`).join(" ") + ">>";
    case "bool":
      return v.v ? "true" : "false";
    case "null":
      return "null";
  }
}

export function serializeContentStream(ops: Operation[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  let text = "";
  const flush = () => {
    if (text) {
      // Content streams are byte strings; everything we emit is ASCII.
      parts.push(enc.encode(text));
      text = "";
    }
  };
  for (const o of ops) {
    if (o.raw) {
      flush();
      parts.push(o.raw);
      text += "\n";
      continue;
    }
    text += (o.operands.length ? o.operands.map(serializeValue).join(" ") + " " : "") + o.op + "\n";
  }
  flush();
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export const num = (v: number): PdfValue => ({ t: "num", v });
export const name = (v: string): PdfValue => ({ t: "name", v });
export const str = (v: Uint8Array): PdfValue => ({ t: "str", v, hex: true });
