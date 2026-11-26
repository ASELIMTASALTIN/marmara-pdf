/**
 * Lazy loader for MuPDF (WASM, AGPL-3.0). MuPDF is only needed for editing
 * operations (writing annotations, text editing, redaction, encryption), so it
 * is loaded on first use to keep startup fast.
 */
export type MuPDF = typeof import("mupdf");

let modPromise: Promise<MuPDF> | null = null;

export function loadMupdf(): Promise<MuPDF> {
  modPromise ??= import("mupdf");
  return modPromise;
}

export type Matrix = [number, number, number, number, number, number];

export function transformPoint(m: Matrix | number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invertMatrix(m: Matrix | number[]): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) throw new Error("Singular matrix");
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(c: number[]): string {
  if (!c || c.length < 3) return "#000000";
  return "#" + c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
}

/** Opens PDF bytes with MuPDF, authenticating if a password is given. */
export async function openMupdf(bytes: Uint8Array, password?: string) {
  const mupdf = await loadMupdf();
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
  if (!doc) throw new Error("Not a PDF document");
  if (doc.needsPassword()) {
    if (!password || !doc.authenticatePassword(password)) throw new Error("Password required to edit this PDF");
  }
  return { mupdf, doc };
}

export function saveMupdf(doc: import("mupdf").PDFDocument, options = "compress,garbage=compact"): Uint8Array {
  const buf = doc.saveToBuffer(options);
  try {
    return buf.asUint8Array().slice();
  } finally {
    buf.destroy?.();
  }
}
