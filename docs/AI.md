# Assistant (local AI)

The **Assistant** side panel (toolbar button or **Ctrl+J**) lets you work on
the open PDF by writing what you want, in Turkish or English:

> *Her sayfanın altına "Sayfa X / Y" ekle* · *"son tarih" geçen yerleri vurgula* ·
> *Bu sayfayı özetle* · *3. sayfayı 90 derece döndür* · *TC kimlik numarasını karart* ·
> *Formda adı "Ayşe Yılmaz" olarak doldur*

Everything runs **on your computer**. Documents and prompts never leave it.
Every change the Assistant makes is a normal edit, so **Ctrl+Z** undoes it.

## What it can do

| Tool | Examples |
|---|---|
| Read the document | summarise, translate, answer questions, find where something is |
| Mark up | highlight / underline / strike out a phrase everywhere; sticky-note comments |
| Edit content | replace text in the PDF itself; write new text at a position |
| Page layout | page numbers, headers and footers, watermarks (and remove them) |
| Pages | rotate, delete, move, insert blank pages, go to a page |
| Privacy | mark sensitive text for redaction; you then apply it with **Tools ▸ Apply redactions** |
| Forms | list fields, fill them (text, checkboxes, choices) |
| Other | bookmarks, OCR of scanned pages, compression, Word export |

## Engine and model

* **Engine:** [llama.cpp](https://github.com/ggml-org/llama.cpp) server (MIT),
  built by `npm run build:engine` into `ai-engine/` and installed as `ai\`.
  It uses the GPU through Vulkan (NVIDIA, AMD and Intel), or the CPU. The best
  CPU variant (SSE4.2 up to AVX-512) is chosen at runtime, so the same files
  run on any Windows PC. It listens only on `127.0.0.1`, on a random port, with
  a random API key, and stops when Marmara PDF closes.
* **Model:** *Gemma 4 E2B it heretic-ara*, quantised to Q4_K_S (3.1 GB,
  Apache-2.0,
  [Hugging Face](https://huggingface.co/mradermacher/gemma-4-E2B-it-heretic-ara-GGUF)).
  The model thinks before it answers; llama.cpp keeps those thoughts out of the
  chat. Speed: about 100 tokens/s on a laptop RTX 4070 and 22 tokens/s on a
  Ryzen 7 7840HS CPU.
* **Where the model is looked for:** `ai\models` next to the app (portable
  copy), `%LOCALAPPDATA%\com.marmara.pdf\models` (installer, download), the
  LM Studio model folder, or any `.gguf` file you choose in the panel's
  settings. Without a model, the panel offers to download it once from Hugging
  Face.
* **Other models:** any GGUF chat model with tool calling works (e.g. Qwen 3,
  Llama 3.x). Choose it in the panel's settings (⚙).

## System requirements

| | Minimum | Recommended |
|---|---|---|
| Windows | 10 or 11, **x64** (ARM PCs are not supported) | Windows 11 |
| CPU | any x64 CPU with SSE4.2 (2009+) | 6+ cores with AVX2 or AVX-512 |
| RAM | 8 GB (CPU mode needs ~4 GB free) | 16 GB |
| GPU (optional) | any GPU with a **Vulkan** driver: NVIDIA (GeForce 900+), AMD (RX 400+, Radeon 680M/780M), Intel Arc/Iris Xe | 4 GB+ video memory |
| Disk | 3.5 GB | SSD |

* **No CUDA, Python or other installs are needed.** NVIDIA, AMD and Intel GPUs are used
  through their normal drivers' Vulkan support. The Visual C++ runtime ships inside `ai\`.
  WebView2 is part of Windows 11; on old Windows 10 builds, Microsoft's free
  "WebView2 Runtime" may be needed.
* **The video memory is used automatically.** The model is fitted to the free video memory,
  and the layers that don't fit run on the CPU. With a 4 GB+ GPU the whole model
  (about 3.4 GB) is on the GPU (≈100 tokens/s on an RTX 4070 Laptop). Without a usable GPU
  it runs on the CPU: measured 22 tokens/s on a Ryzen 7 7840HS. The first request then takes
  about 20–30 s, while the assistant's instructions are read; later requests reuse them and
  start quickly. Older or smaller CPUs are proportionally slower.
  You can force CPU mode in the panel's settings (⚙).
* The first start of the engine on a PC takes longer, while GPU shaders are prepared.

## Why the model is not inside the installer

Windows installers (NSIS and MSI) and GitHub release files are limited to 2 GB.
The 3.1 GB model therefore ships **next to** the installer
(`Marmara PDF <version> Setup\models\`), where setup picks it up. The
**portable** package keeps it in `ai\models`. Copies from GitHub download it on
first use.

## Development

```sh
npm run build:engine                      # llama.cpp → ai-engine/ (VS 2022, CMake, Vulkan SDK)
ai-engine\llama-server.exe -m models\<model>.gguf --port 8080 --jinja
npm run dev                               # the browser build talks to 127.0.0.1:8080
```

The agent loop is in `src/ai/agent.ts` and the tools are in `src/ai/tools.ts`
(JSON Schemas plus executors on the document store). Engine management is in
`src-tauri/src/ai.rs`. `tests/ui/assistant.js` drives the panel end to end
with the real model.
