// Builds the self-contained command-line package in dist-cli/:
//   marmara.mjs            the CLI (all of src/cli + src/core bundled)
//   node_modules/          MuPDF and Tesseract (+ their runtime dependencies), pruned
//   tessdata/              Turkish + English OCR models
//   node.exe               Node.js runtime (with --with-node; used by the installer)
// Usage: node scripts/build-cli.mjs [--with-node]
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-cli");
const nm = join(root, "node_modules");
const withNode = process.argv.includes("--with-node");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. Bundle.
execFileSync(process.execPath, [join(nm, "vite", "bin", "vite.js"), "build", "--config", "vite.cli.config.ts", "--logLevel", "warn"], { cwd: root, stdio: "inherit" });

// 2. External packages and their runtime dependencies.
const SKIP = /(\.md|\.map|\.d\.ts|\.br|\.gz|\.ts)$|[\\/](test|tests|docs|examples|benchmarks?|\.github)[\\/]|[\\/]CHANGELOG/i;
// Tesseract under Node loads tesseract-core*.js + .wasm (the variant depends on the CPU and engine
// mode); the .wasm.js copies (WASM embedded as base64, for browsers) are not needed.
const keepCoreFile = (p) => !/tesseract\.js-core[\\/]tesseract-core/.test(p) || /tesseract-core[a-z-]*\.(js|wasm)$/.test(p);
const done = new Set();
function copyPackage(name) {
  if (done.has(name)) return;
  done.add(name);
  const src = join(nm, name);
  if (!existsSync(src)) throw new Error(`Missing dependency ${name}`);
  const pkg = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));
  cpSync(src, join(out, "node_modules", name), {
    recursive: true,
    filter: (p) => {
      const rel = relative(src, p);
      if (rel.startsWith("node_modules")) return false;
      if (name === "tesseract.js" && /^dist[\\/]/.test(rel)) return false; // browser builds
      return (statSync(p).isDirectory() || !SKIP.test(p) || /package\.json$/.test(p)) && keepCoreFile(p);
    },
  });
  for (const dep of Object.keys(pkg.dependencies ?? {})) if (dep !== "opencollective-postinstall") copyPackage(dep);
}
copyPackage("mupdf");
copyPackage("tesseract.js");

// 3. OCR language data.
mkdirSync(join(out, "tessdata"), { recursive: true });
for (const lang of ["tur", "eng"]) copyFileSync(join(nm, "@tesseract.js-data", lang, "4.0.0_best_int", `${lang}.traineddata.gz`), join(out, "tessdata", `${lang}.traineddata.gz`));

// 4. Node runtime for the installer.
if (withNode) {
  copyFileSync(process.execPath, join(out, "node.exe"));
  const lic = join(dirname(process.execPath), "LICENSE");
  if (existsSync(lic)) copyFileSync(lic, join(out, "NODE-LICENSE.txt"));
}

writeFileSync(
  join(out, "README.txt"),
  [
    "Marmara PDF command line",
    "",
    "Run: marmara help        (installed: marmara.exe is on PATH)",
    "     node marmara.mjs help (portable, with Node.js 20+)",
    "",
    "MCP server for local LLM clients: marmara mcp [--root <folder>]",
    "Licensed under AGPL-3.0-or-later (MuPDF). Node.js: MIT (NODE-LICENSE.txt).",
    "",
  ].join("\r\n"),
);

// Summary.
let total = 0;
const walk = (d) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : (total += statSync(join(d, e.name)).size)));
walk(out);
console.log(`[build-cli] dist-cli ready (${(total / 1024 / 1024).toFixed(1)} MB${withNode ? ", with node.exe" : ""}); packages: ${[...done].join(", ")}`);
