import { PDFDocument } from "pdf-lib";

export type PageFit = "image" | "a4";

const A4: [number, number] = [595.28, 841.89];

function isPng(b: Uint8Array) {
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}
function isJpeg(b: Uint8Array) {
  return b[0] === 0xff && b[1] === 0xd8;
}

/**
 * Creates a PDF with one page per image. "image": page size equals the image
 * at 96 DPI; "a4": the image is fitted onto an A4 page (orientation follows
 * the image) with a small margin.
 */
export async function imagesToPdf(images: { name: string; bytes: Uint8Array }[], fit: PageFit = "a4"): Promise<Uint8Array> {
  if (!images.length) throw new Error("No images selected");
  const doc = await PDFDocument.create();
  doc.setProducer("Marmara PDF");
  for (const img of images) {
    const embedded = isPng(img.bytes) ? await doc.embedPng(img.bytes) : isJpeg(img.bytes) ? await doc.embedJpg(img.bytes) : null;
    if (!embedded) throw new Error(`${img.name} is not a PNG or JPEG image`);
    const wPt = (embedded.width * 72) / 96;
    const hPt = (embedded.height * 72) / 96;
    if (fit === "image") {
      doc.addPage([wPt, hPt]).drawImage(embedded, { x: 0, y: 0, width: wPt, height: hPt });
      continue;
    }
    const landscape = embedded.width > embedded.height;
    const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
    const margin = 24;
    const s = Math.min((pw - 2 * margin) / wPt, (ph - 2 * margin) / hPt, 1);
    const w = wPt * s;
    const h = hPt * s;
    doc.addPage([pw, ph]).drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return doc.save();
}
