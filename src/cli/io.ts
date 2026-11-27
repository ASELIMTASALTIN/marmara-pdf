import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { invertMatrix, openMupdf, transformPoint, type Matrix } from "../core/mupdf/loader";
import { parsePageRanges } from "../core/pdf/pageOps";
import type { Point, Rect } from "../core/annotations/types";
import { UsageError, type Args, type Context } from "./registry";

export function resolvePath(ctx: Context, p: string): string {
  const full = resolve(isAbsolute(p) ? p : resolve(ctx.cwd, p));
  if (ctx.roots?.length) {
    const inside = ctx.roots.some((r) => {
      const rel = relative(resolve(r), full);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (!inside) throw new UsageError(`Access to ${full} is not allowed: only files inside ${ctx.roots.join(", ")} can be used.`);
  }
  return full;
}

export function readBytes(ctx: Context, p: string): Uint8Array {
  const full = resolvePath(ctx, p);
  if (!existsSync(full)) throw new UsageError(`File not found: ${full}`);
  return new Uint8Array(readFileSync(full));
}

export interface PdfInput {
  path: string;
  name: string;
  /** Decrypted working bytes. */
  bytes: Uint8Array;
  /** Password the file needed (re-applied when writing). */
  password?: string;
  /** Number of digital signatures in the file. */
  signatures: number;
}

function looksLikePdf(b: Uint8Array) {
  const head = new TextDecoder("latin1").decode(b.subarray(0, 1024));
  return head.includes("%PDF-");
}

/** Reads a PDF, decrypting it when needed. */
export async function loadPdf(ctx: Context, path: string, password?: string): Promise<PdfInput> {
  const full = resolvePath(ctx, path);
  let bytes = readBytes(ctx, path);
  if (!looksLikePdf(bytes)) throw new UsageError(`Not a PDF file: ${full}`);
  const { looksEncrypted, decryptPdf } = await import("../core/mupdf/security");
  let needed: string | undefined;
  if (looksEncrypted(bytes)) {
    try {
      bytes = await decryptPdf(bytes, "");
    } catch {
      if (!password) throw new UsageError(`${basename(full)} is password protected. Pass --password.`);
      try {
        bytes = await decryptPdf(bytes, password);
      } catch {
        throw new UsageError(`Wrong password for ${basename(full)}.`);
      }
      needed = password;
    }
  }
  const { countSignatures } = await import("../core/signature/verify");
  const signatures = await countSignatures(bytes).catch(() => 0);
  return { path: full, name: basename(full), bytes, password: needed, signatures };
}

/** Refuses to rewrite a signed file unless break_signatures is set. */
export function guardSignatures(input: PdfInput, args: Args) {
  if (input.signatures && !args.break_signatures)
    throw new UsageError(
      `${input.name} has ${input.signatures} digital signature${input.signatures > 1 ? "s" : ""}; this change would invalidate ${input.signatures > 1 ? "them" : "it"}. Pass --break-signatures to proceed.`,
    );
}

export function stem(name: string) {
  return basename(name, extname(name));
}

function freePath(dir: string, base: string, ext: string) {
  let p = join(dir, `${base}${ext}`);
  for (let k = 2; existsSync(p); k++) p = join(dir, `${base}-${k}${ext}`);
  return p;
}

/** Atomic write: temp file + rename. */
export function writeAtomic(path: string, bytes: Uint8Array) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Resolves where to write a result. Explicit paths must not exist unless
 * overwrite is set; without a path, a free name next to `near` is chosen (or
 * `near` itself when overwrite is set and `inPlace` allowed).
 */
export function outputPath(ctx: Context, args: Args, near: string, suffix: string, ext: string, inPlace = true): string {
  const given = args.output as string | undefined;
  if (given) {
    const full = resolvePath(ctx, given);
    if (existsSync(full) && !args.overwrite) throw new UsageError(`${full} already exists. Pass --overwrite to replace it.`);
    return full;
  }
  if (args.overwrite && inPlace && extname(near).toLowerCase() === ext) return near;
  return freePath(dirname(near), `${stem(near)}.${suffix}`, ext);
}

/** Writes a resulting PDF (re-encrypting it with the input's password). */
export async function writePdf(ctx: Context, args: Args, input: PdfInput, bytes: Uint8Array, suffix: string): Promise<string> {
  const path = outputPath(ctx, args, input.path, suffix, ".pdf");
  let out = bytes;
  if (input.password) {
    const { encryptPdf } = await import("../core/mupdf/security");
    out = await encryptPdf(bytes, input.password);
  }
  writeAtomic(path, out);
  return path;
}

/** Writes a non-PDF result (docx, txt, png…). */
export function writeFile(ctx: Context, args: Args, near: string, bytes: Uint8Array, suffix: string, ext: string): string {
  const path = outputPath(ctx, args, near, suffix, ext, false);
  writeAtomic(path, bytes);
  return path;
}

/** Output directory for multi-file results (created if missing). */
export function outputDir(ctx: Context, args: Args, near: string, suffix: string): string {
  const dir = args.output_dir ? resolvePath(ctx, args.output_dir as string) : join(dirname(near), `${stem(near)}-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function fileInDir(dir: string, name: string, overwrite: boolean) {
  const p = join(dir, name);
  if (existsSync(p) && !overwrite) {
    const ext = extname(name);
    return freePath(dir, basename(name, ext), ext);
  }
  return p;
}

/** 0-based page indices from a 1-based range expression ("all" = every page). */
export function selectPages(expr: unknown, count: number): number[] {
  const e = typeof expr === "string" ? expr.trim() : "";
  if (!e || /^all$/i.test(e)) return Array.from({ length: count }, (_, i) => i);
  try {
    return [...new Set(parsePageRanges(e.replace(/\blast\b/gi, String(count)), count))];
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

export function pageIndex(page: unknown, count: number): number {
  const n = Number(page);
  if (!Number.isInteger(n) || n < 1 || n > count) throw new UsageError(`Page ${page} does not exist (the document has ${count} page${count === 1 ? "" : "s"}).`);
  return n - 1;
}

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
  if (r[2] <= r[0] || r[3] <= r[1]) throw new UsageError(`Invalid rectangle ${r.join(",")}: expected x0<x1 and y0<y1.`);
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

export function mb(n: number) {
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
