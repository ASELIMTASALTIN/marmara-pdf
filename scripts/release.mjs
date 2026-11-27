// Builds a Marmara PDF release.
//
//   node scripts/release.mjs             build + local packages in release/v<version>/
//   node scripts/release.mjs --publish   … and publish them as a GitHub release (gh CLI)
//   node scripts/release.mjs --skip-build  reuse the last build
//
// Local packages (models/*.gguf is included when present):
//   "Marmara PDF <v> Setup/"     installer + models/ — the installer copies the model for the user
//   "Marmara PDF <v> Portable/"  runs from any folder (USB stick…): app, CLI, AI engine and model
// GitHub release (files must stay under 2 GB, so no model; the app downloads it on first use):
//   MarmaraPDF_<v>_x64-setup.exe (+ .sig), MarmaraPDF_<v>_x64.msi, MarmaraPDF_<v>_portable.zip,
//   latest.json — read by "Check for updates" (signed with the key in ~/.tauri/marmara-pdf.key)
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const product = conf.productName;
const publish = process.argv.includes("--publish");
const skipBuild = process.argv.includes("--skip-build");
const repo = "ASELIMTASALTIN/marmara-pdf";
const keyPath = process.env.MARMARA_UPDATER_KEY ?? join(homedir(), ".tauri", "marmara-pdf.key");
const target = join(root, "src-tauri", "target", "release");
const bundle = join(target, "bundle");
const out = join(root, "release", `v${version}`);
const log = (m) => console.log(`[release] ${m}`);
const run = (cmd, args, env) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" && cmd === "npm" });

// 1. Build (installers signed for the updater when the key is available).
if (!skipBuild) {
  if (existsSync(keyPath)) {
    log(`building ${product} ${version} with updater signatures`);
    run("npm", ["run", "tauri", "build"], { TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, "utf8").trim(), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" });
  } else {
    if (publish) throw new Error(`Updater key not found at ${keyPath}; cannot publish an update.`);
    log("updater key not found: building without update signatures");
    run("npm", ["run", "tauri", "build", "--", "--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } })]);
  }
}

const setup = join(bundle, "nsis", `${product}_${version}_x64-setup.exe`);
const msi = join(bundle, "msi", `${product}_${version}_x64_en-US.msi`);
if (!existsSync(setup)) throw new Error(`Installer not found: ${setup}`);

/** Hard link when possible (same drive, saves 3 GB), else copy. */
function place(src, dst) {
  mkdirSync(dirname(dst), { recursive: true });
  rmSync(dst, { force: true });
  try {
    linkSync(src, dst);
  } catch {
    copyFileSync(src, dst);
  }
}

// 2. Local packages.
const models = existsSync(join(root, "models")) ? readdirSync(join(root, "models")).filter((f) => f.endsWith(".gguf")) : [];
rmSync(out, { recursive: true, force: true });
const setupDir = join(out, `${product} ${version} Setup`);
place(setup, join(setupDir, basename(setup)));
for (const m of models) place(join(root, "models", m), join(setupDir, "models", m));
writeFileSync(
  join(setupDir, "README.txt"),
  [
    `${product} ${version}`,
    "",
    `1. Run "${basename(setup)}".`,
    models.length ? "2. The AI assistant's model in the \"models\" folder is installed automatically — keep the folder next to the setup program." : "2. The AI assistant downloads its model on first use.",
    "",
    "Updates: Settings (gear icon) > Check for updates.",
    `Source code: https://github.com/${repo} (AGPL-3.0-or-later)`,
    "",
  ].join("\r\n"),
);

const portableDir = join(out, `${product} ${version} Portable`);
mkdirSync(portableDir, { recursive: true });
copyFileSync(join(target, "marmara-pdf.exe"), join(portableDir, `${product}.exe`));
copyFileSync(join(target, "marmara.exe"), join(portableDir, "marmara.exe"));
cpSync(join(target, "cli"), join(portableDir, "cli"), { recursive: true });
cpSync(join(target, "ai"), join(portableDir, "ai"), { recursive: true, filter: (p) => !/[\\/]models[\\/]?/.test(p.slice(join(target, "ai").length)) });
writeFileSync(join(portableDir, "portable.txt"), "This copy of Marmara PDF runs from this folder. Updates: download the new portable package from GitHub.\r\n");
writeFileSync(
  join(portableDir, "README.txt"),
  [
    `${product} ${version} — portable`,
    "",
    `Start "${product}.exe". Copy the whole folder anywhere (another drive, a USB stick); nothing needs installing.`,
    "Requires Windows 10/11 with the Microsoft Edge WebView2 runtime (included in Windows 11).",
    "The AI model lives in ai\\models; if it is missing the assistant offers to download it.",
    "Command line: marmara.exe help   |   MCP server for local LLM apps: marmara.exe mcp",
    "",
  ].join("\r\n"),
);
// Zip for GitHub (without the model) before the model is added to the folder.
const zipName = `MarmaraPDF_${version}_portable.zip`;
const stage = join(out, "github");
mkdirSync(stage, { recursive: true });
execFileSync("tar", ["-a", "-c", "-f", join(stage, zipName), "-C", out, basename(portableDir)], { stdio: "inherit" });
for (const m of models) place(join(root, "models", m), join(portableDir, "ai", "models", m));
log(`local packages in ${out}`);

// 3. GitHub release assets + updater manifest.
const assetSetup = `MarmaraPDF_${version}_x64-setup.exe`;
copyFileSync(setup, join(stage, assetSetup));
if (existsSync(msi)) copyFileSync(msi, join(stage, `MarmaraPDF_${version}_x64.msi`));
const sig = `${setup}.sig`;
if (existsSync(sig)) {
  copyFileSync(sig, join(stage, `${assetSetup}.sig`));
  const notesFile = join(root, "release", "notes", `v${version}.md`);
  const notes = existsSync(notesFile) ? readFileSync(notesFile, "utf8").trim() : `${product} ${version}`;
  writeFileSync(
    join(stage, "latest.json"),
    JSON.stringify(
      {
        version,
        notes,
        pub_date: new Date().toISOString(),
        platforms: { "windows-x86_64": { signature: readFileSync(sig, "utf8").trim(), url: `https://github.com/${repo}/releases/download/v${version}/${assetSetup}` } },
      },
      null,
      2,
    ),
  );
} else log("no updater signature: latest.json not written");
for (const f of readdirSync(stage)) log(`  github asset: ${f} (${(statSync(join(stage, f)).size / 1048576).toFixed(1)} MB)`);

if (publish) {
  const notesFile = join(root, "release", "notes", `v${version}.md`);
  const files = readdirSync(stage).map((f) => join(stage, f));
  const args = ["release", "create", `v${version}`, ...files, "--repo", repo, "--title", `${product} ${version}`];
  args.push(...(existsSync(notesFile) ? ["--notes-file", notesFile] : ["--notes", `${product} ${version}`]));
  log(`publishing v${version} to github.com/${repo}`);
  execFileSync("gh", args, { stdio: "inherit", cwd: root });
}
