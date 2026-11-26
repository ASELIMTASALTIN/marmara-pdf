// Copies runtime assets of pdf.js / Tesseract into public/vendor so the app
// works fully offline: nothing is fetched from a CDN at runtime.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const out = join(root, "public", "vendor");

const copies = [
  ["pdfjs-dist/cmaps", "pdfjs/cmaps"],
  ["pdfjs-dist/standard_fonts", "pdfjs/standard_fonts"],
  ["pdfjs-dist/wasm", "pdfjs/wasm"],
  ["pdfjs-dist/iccs", "pdfjs/iccs"],
  ["tesseract.js/dist/worker.min.js", "tesseract/worker.min.js"],
  ["tesseract.js-core", "tesseract/core"],
  ["@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "tesseract/lang/eng.traineddata.gz"],
  ["@tesseract.js-data/tur/4.0.0_best_int/tur.traineddata.gz", "tesseract/lang/tur.traineddata.gz"],
];

rmSync(out, { recursive: true, force: true });
for (const [from, to] of copies) {
  const src = join(nm, from);
  if (!existsSync(src)) {
    console.warn(`[copy-assets] missing ${from}, skipped`);
    continue;
  }
  const dst = join(out, to);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, {
    recursive: true,
    filter: (p) => !/\.(md|map|d\.ts)$|package\.json$|[\\/]src[\\/]/i.test(p),
  });
}
console.log("[copy-assets] vendor assets ready in public/vendor");
