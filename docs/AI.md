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
  chat. Speed: about 100 tokens/s on a laptop RTX 4070 and about 15–25 tokens/s
  on a modern CPU.
* **Where the model is looked for:** `ai\models` next to the app (portable
  copy), `%LOCALAPPDATA%\com.marmara.pdf\models` (installer, download), the
  LM Studio model folder, or any `.gguf` file you choose in the panel's
  settings. Without a model, the panel offers to download it once from Hugging
  Face.
* **Other models:** any GGUF chat model with tool calling works (e.g. Qwen 3,
  Llama 3.x). Choose it in the panel's settings (⚙).

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
