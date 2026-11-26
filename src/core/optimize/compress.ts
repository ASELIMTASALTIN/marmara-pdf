import { loadMupdf, openMupdf, saveMupdf } from "../mupdf/loader";
import { parseContentStream } from "../textedit/contentStream";
import { mul, IDENTITY, type Matrix } from "../textedit/interpreter";

type PDFObject = import("mupdf").PDFObject;
const R = (o: PDFObject): PDFObject => (o.isNull() ? o : o.resolve());

export interface CompressOptions {
  /** Target resolution for images (0 = keep images unchanged). */
  imageDpi: number;
  /** JPEG quality 1–100 for re-encoded images. */
  jpegQuality: number;
}

export interface CompressResult {
  bytes: Uint8Array;
  before: number;
  after: number;
  imagesRecompressed: number;
}

export const COMPRESS_PRESETS: Record<string, CompressOptions & { label: string }> = {
  screen: { label: "Smallest file (screen, 72 DPI images)", imageDpi: 72, jpegQuality: 50 },
  ebook: { label: "Balanced (150 DPI images)", imageDpi: 150, jpegQuality: 70 },
  print: { label: "High quality (220 DPI images)", imageDpi: 220, jpegQuality: 85 },
  lossless: { label: "Lossless (no image changes)", imageDpi: 0, jpegQuality: 100 },
};

function readStream(ref: PDFObject): Uint8Array {
  const buf = ref.readStream();
  const out = buf.asUint8Array().slice();
  buf.destroy?.();
  return out;
}

/** Largest displayed size (points) of each image XObject, keyed by object number. */
function measureImages(doc: import("mupdf").PDFDocument): Map<number, { w: number; h: number; ref: PDFObject }> {
  const sizes = new Map<number, { w: number; h: number; ref: PDFObject }>();
  const visit = (contents: Uint8Array, resources: PDFObject, base: Matrix, depth: number) => {
    const xdict = resources.isDictionary() ? R(resources.get("XObject")) : null;
    const ops = parseContentStream(contents);
    const stack: Matrix[] = [];
    let ctm = base;
    for (const o of ops) {
      if (o.op === "q") stack.push(ctm);
      else if (o.op === "Q") ctm = stack.pop() ?? base;
      else if (o.op === "cm") ctm = mul(o.operands.map((v) => (v.t === "num" ? v.v : 0)) as Matrix, ctm);
      else if (o.op === "Do" && o.operands[0]?.t === "name" && xdict?.isDictionary()) {
        const ref = xdict.get(o.operands[0].v);
        if (ref.isNull() || !ref.isIndirect()) continue;
        const d = R(ref);
        const sub = R(d.get("Subtype"));
        if (sub.isName() && sub.asName() === "Image") {
          const w = Math.hypot(ctm[0], ctm[1]);
          const h = Math.hypot(ctm[2], ctm[3]);
          const num = ref.asIndirect();
          const prev = sizes.get(num);
          if (!prev || w * h > prev.w * prev.h) sizes.set(num, { w, h, ref });
        } else if (sub.isName() && sub.asName() === "Form" && depth < 4 && ref.isStream()) {
          const m = R(d.get("Matrix"));
          const fm: Matrix = m.isArray() ? ([0, 1, 2, 3, 4, 5].map((k) => m.get(k).asNumber()) as Matrix) : [...IDENTITY];
          const res = R(d.get("Resources"));
          visit(readStream(ref), res.isDictionary() ? res : resources, mul(fm, ctm), depth + 1);
        }
      }
    }
  };
  for (let i = 0; i < doc.countPages(); i++) {
    const page = (doc.loadPage(i) as import("mupdf").PDFPage).getObject();
    const ref = page.get("Contents");
    const parts: PDFObject[] = ref.isStream() ? [ref] : (() => {
      const a = R(ref);
      const out: PDFObject[] = [];
      if (a.isArray()) for (let k = 0; k < a.length; k++) out.push(a.get(k));
      return out;
    })();
    const bytes = parts.filter((p) => p.isStream()).map(readStream);
    const joined = new Uint8Array(bytes.reduce((n, b) => n + b.length + 1, 0));
    let off = 0;
    for (const b of bytes) {
      joined.set(b, off);
      off += b.length;
      joined[off++] = 10;
    }
    visit(joined, R(page.getInheritable("Resources")), [...IDENTITY], 0);
  }
  return sizes;
}

/**
 * Reduces file size: downsamples and re-encodes images above the target
 * resolution (JPEG), removes duplicate/unused objects and compresses streams.
 */
export async function compressPdf(bytes: Uint8Array, opts: CompressOptions, onProgress?: (done: number, total: number) => void): Promise<CompressResult> {
  const mupdf = await loadMupdf();
  const { doc } = await openMupdf(bytes);
  let recompressed = 0;
  try {
    if (opts.imageDpi > 0) {
      const images = measureImages(doc);
      let done = 0;
      for (const { w, h, ref } of images.values()) {
        onProgress?.(++done, images.size);
        const dict = R(ref);
        // Skip masks and special encodings that JPEG cannot represent faithfully.
        if (R(dict.get("ImageMask")).isBoolean() && R(dict.get("ImageMask")).asBoolean()) continue;
        if (!R(dict.get("Mask")).isNull() || !R(dict.get("Decode")).isNull()) continue;
        const bpc = R(dict.get("BitsPerComponent"));
        if (bpc.isNumber() && bpc.asNumber() < 8) continue;
        const filter = R(dict.get("Filter"));
        const filterName = filter.isName() ? filter.asName() : filter.isArray() && filter.length ? R(filter.get(filter.length - 1)).asName() : "";
        if (filterName === "JBIG2Decode" || filterName === "CCITTFaxDecode" || filterName === "JPXDecode") continue;
        const pw = R(dict.get("Width")).asNumber();
        const ph = R(dict.get("Height")).asNumber();
        if (!w || !h || pw < 64 || ph < 64) continue;
        const dpiX = pw / (w / 72);
        const dpiY = ph / (h / 72);
        const scale = Math.min(1, opts.imageDpi / Math.min(dpiX, dpiY));
        const needsDownsample = scale < 0.9;
        if (!needsDownsample && filterName === "DCTDecode") continue; // already JPEG at an acceptable resolution
        let pix: import("mupdf").Pixmap;
        try {
          pix = doc.loadImage(ref).toPixmap();
        } catch {
          continue;
        }
        try {
          if (pix.getAlpha?.()) continue;
          let target = pix;
          const nw = Math.max(1, Math.round(pw * scale));
          const nh = Math.max(1, Math.round(ph * scale));
          if (needsDownsample) target = pix.warp([[0, 0], [pw, 0], [pw, ph], [0, ph]], nw, nh);
          const cs = target.getColorSpace();
          if (cs && !cs.isRGB() && !cs.isGray()) target = target.convertToColorSpace(mupdf.ColorSpace.DeviceRGB);
          const jpeg = target.asJPEG(opts.jpegQuality);
          const rawLen = ref.readRawStream().asUint8Array().length;
          if (jpeg.length >= rawLen * 0.95) continue; // not worth it
          // Replace the image's data in place so every page referencing it is updated.
          const gray = target.getColorSpace()?.isGray() ?? false;
          ref.writeRawStream(jpeg);
          dict.put("Width", nw);
          dict.put("Height", nh);
          dict.put("BitsPerComponent", 8);
          dict.put("ColorSpace", doc.newName(gray ? "DeviceGray" : "DeviceRGB"));
          dict.put("Filter", doc.newName("DCTDecode"));
          dict.delete("DecodeParms");
          recompressed++;
        } finally {
          pix.destroy?.();
        }
      }
    }
    let out: Uint8Array;
    try {
      out = saveMupdf(doc, "garbage=deduplicate,compress,compress-fonts,compress-images,objstms");
    } catch {
      out = saveMupdf(doc, "garbage=deduplicate,compress");
    }
    // Never return something bigger than the input.
    if (out.length >= bytes.length && !recompressed) out = bytes;
    return { bytes: out, before: bytes.length, after: out.length, imagesRecompressed: recompressed };
  } finally {
    doc.destroy();
  }
}
