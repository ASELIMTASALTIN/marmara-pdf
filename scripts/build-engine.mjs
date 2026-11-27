// Builds Marmara PDF's local AI engine — the llama.cpp server (MIT) — into ai-engine/.
//
// GPU: Vulkan (NVIDIA, AMD, Intel). CPU: every x64 variant (SSE4.2 … AVX-512), picked at
// runtime. Backends are separate DLLs loaded on demand, so the same files run on any
// Windows PC: on the GPU when one is usable, otherwise on the CPU.
//
// Needs Visual Studio 2022 (C++), CMake, Git and the Vulkan SDK (VULKAN_SDK; without it a
// CPU-only engine is built).  Usage: node scripts/build-engine.mjs [--tag b12811] [--cpu-only]
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(root, "engine-src");
const src = join(srcRoot, "llama.cpp");
const build = join(srcRoot, "build");
const out = join(root, "ai-engine");
const argTag = process.argv.indexOf("--tag");
const tagFile = join(srcRoot, "LLAMA_CPP_TAG");
const tag = argTag > 0 ? process.argv[argTag + 1] : existsSync(tagFile) ? readFileSync(tagFile, "utf8").trim() : "b12811";
const vulkan = !process.argv.includes("--cpu-only") && !!process.env.VULKAN_SDK;
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit", cwd: root });

if (!existsSync(join(src, "CMakeLists.txt"))) {
  mkdirSync(srcRoot, { recursive: true });
  run("git", ["clone", "--depth", "1", "--branch", tag, "https://github.com/ggml-org/llama.cpp.git", src]);
  writeFileSync(tagFile, tag);
}
console.log(`[engine] llama.cpp ${tag}, Vulkan ${vulkan ? "on" : "off"}`);
run("cmake", [
  "-S", src, "-B", build, "-G", "Visual Studio 17 2022", "-A", "x64",
  "-DBUILD_SHARED_LIBS=ON", "-DGGML_BACKEND_DL=ON", "-DGGML_CPU_ALL_VARIANTS=ON", "-DGGML_NATIVE=OFF",
  `-DGGML_VULKAN=${vulkan ? "ON" : "OFF"}`, "-DLLAMA_CURL=OFF", "-DLLAMA_BUILD_TESTS=OFF", "-DLLAMA_BUILD_EXAMPLES=OFF",
  "-DLLAMA_BUILD_SERVER=ON", "-DLLAMA_BUILD_TOOLS=ON",
]);
run("cmake", ["--build", build, "--config", "Release", "--target", "llama-server", ...(vulkan ? ["ggml-vulkan"] : []), "--parallel"]);

const bin = join(build, "bin", "Release");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(join(bin, "llama-server.exe"), join(out, "llama-server.exe"));
for (const f of readdirSync(bin)) if (f.endsWith(".dll")) copyFileSync(join(bin, f), join(out, f));
copyFileSync(join(src, "LICENSE"), join(out, "LLAMA-CPP-LICENSE.txt"));

// The engine uses the Visual C++ runtime (MSVCP140, VCRUNTIME140…), which a clean Windows
// install may lack: ship it app-local (allowed by the Visual Studio redistribution terms).
const redistRoot = join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft Visual Studio", "2022");
let crt = null;
for (const edition of existsSync(redistRoot) ? readdirSync(redistRoot) : []) {
  const msvc = join(redistRoot, edition, "VC", "Redist", "MSVC");
  if (!existsSync(msvc)) continue;
  for (const v of readdirSync(msvc).filter((d) => /^\d/.test(d)).sort().reverse()) {
    const dir = join(msvc, v, "x64", "Microsoft.VC143.CRT");
    if (existsSync(join(dir, "msvcp140.dll"))) {
      crt = dir;
      break;
    }
  }
  if (crt) break;
}
if (!crt) throw new Error("Visual C++ redistributable DLLs (Microsoft.VC143.CRT) not found in the Visual Studio installation.");
for (const f of readdirSync(crt)) if (/\.dll$/i.test(f)) copyFileSync(join(crt, f), join(out, f));
writeFileSync(join(out, "VERSION.txt"), `llama.cpp ${tag} (Vulkan ${vulkan ? "on" : "off"}, all CPU variants, backend DLLs)\r\n`);
const files = readdirSync(out);
const mb = files.reduce((n, f) => n + statSync(join(out, f)).size, 0) / 1048576;
console.log(`[engine] ai-engine ready: ${files.length} files, ${mb.toFixed(1)} MB`);
