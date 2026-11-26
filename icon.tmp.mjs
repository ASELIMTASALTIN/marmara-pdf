import * as mupdf from "mupdf";
import { readFileSync, writeFileSync } from "node:fs";
const doc = mupdf.Document.openDocument(readFileSync("assets/icon.svg"), "image/svg+xml");
const page = doc.loadPage(0);
const b = page.getBounds();
const s = 1024 / (b[2] - b[0]);
const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, true, true);
writeFileSync("assets/icon-1024.png", pix.asPNG());
console.log(pix.getWidth(), pix.getHeight());
