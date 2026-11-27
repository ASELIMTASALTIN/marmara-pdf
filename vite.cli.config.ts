// Builds the command-line tool (src/cli) into a single Node ES module: dist-cli/marmara.mjs.
// MuPDF and Tesseract stay external (they load WASM/worker files from disk) and are copied
// into dist-cli/node_modules by scripts/build-cli.mjs.
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  publicDir: false,
  build: {
    ssr: "src/cli/bin.ts",
    outDir: "dist-cli",
    emptyOutDir: false,
    target: "node20",
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: ["mupdf", "tesseract.js", /^node:/],
      output: { format: "es", entryFileNames: "marmara.mjs", codeSplitting: false } as Record<string, unknown>,
    },
  },
  ssr: { noExternal: true, external: ["mupdf", "tesseract.js"], target: "node" },
});
