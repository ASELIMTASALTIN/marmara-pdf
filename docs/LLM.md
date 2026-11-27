# Using Marmara PDF from a local LLM

Every feature of the editor is also available as a command line tool,
`marmara`, and as an **MCP server** (`marmara mcp`). A local model (LM Studio,
Jan, AnythingLLM, Open WebUI, Continue, Ollama-based agents, …) can read,
edit, annotate, fill, sign, redact, OCR and convert PDFs with it. Everything
runs on your computer, and documents are never uploaded.

The full command reference is in [CLI.md](CLI.md). You can also get it from
`marmara help` and `marmara help <command>`.

## Installation

The Windows installer puts `marmara.exe` next to the app and adds the install
folder to your `PATH`. Open a **new** terminal and check that it works:

```
marmara --version
marmara info "C:\Users\you\Documents\report.pdf"
```

The command line ships with its own Node.js runtime, so nothing else is needed.
The install folder is:

* NSIS installer (`…-setup.exe`, per user): `%LOCALAPPDATA%\Marmara PDF\marmara.exe`
* MSI installer (per machine): `C:\Program Files\Marmara PDF\marmara.exe`

From a source checkout, run `npm run build:cli`, then `node dist-cli/marmara.mjs …`.
The `dist-cli` folder is portable on any machine with Node.js 20 or newer.

## Option 1: MCP server (recommended)

Most local LLM apps can start MCP servers over stdio. Add Marmara PDF to the
app's MCP configuration (often an `mcp.json` with an `mcpServers` object):

```json
{
  "mcpServers": {
    "marmara-pdf": {
      "command": "marmara",
      "args": ["mcp", "--root", "C:\\Users\\you\\Documents"]
    }
  }
}
```

* `--root <folder>` limits the files the model can read or write to that folder.
  Repeat it to allow several folders. Without `--root`, every file the user can
  access is allowed.
* If the app does not see your `PATH`, use the full path to `marmara.exe`, for
  example `C:\\Users\\you\\AppData\\Local\\Marmara PDF\\marmara.exe`.

The server exposes one tool per command, each named `pdf_<command>`:
`pdf_info`, `pdf_search`, `pdf_edit_text`, `pdf_annotate`, `pdf_fill`,
`pdf_redact`, `pdf_ocr`, `pdf_to_word`, and so on. Each tool has a full JSON
Schema. Read-only tools (`pdf_info`, `pdf_text`, `pdf_search`, `pdf_fields`, …)
are marked with `readOnlyHint`, so clients can approve them automatically.

## Option 2: Plain tool calling or shell access

If your agent can run shell commands, it can call `marmara` directly. Every
command prints a JSON result. For function calling without MCP:

1. `marmara commands` prints every command with its description and a JSON
   Schema for its parameters. Register these as functions.
2. When the model calls a function, run it with the model's JSON arguments:

   ```
   marmara call search "{\"input\": \"C:/docs/report.pdf\", \"query\": \"toplam\"}"
   ```

   You can also pipe the JSON on stdin: `echo {...} | marmara call search`.

## How the tools behave

* **Originals are kept.** A command that changes a document writes a new file
  and returns its path as `output`, for example `report.annotated.pdf` next to
  the input. Existing files are never replaced unless `overwrite` is set. To
  chain edits, pass the previous `output` as the next `input`.
* **Pages are 1-based.** A selection looks like `"3"`, `"1-4,7"`, `"5-"` or `"all"`.
* **Coordinates** are points (1/72 inch) from the top-left corner of the page
  as it is displayed, with y growing downwards. A model can render a page with
  `to-images` at any dpi and convert pixels with `point = pixel × 72 / dpi`.
  `search`, `text-blocks`, `objects` and `fields` return rectangles in the same
  frame, so they can be passed straight to `annotate`, `redact`, `add-field`
  or `edit-object`.
* **Errors** come back as `{"ok": false, "error": "…"}` with an explanation the
  model can act on, such as a missing password, an unknown field name with the
  available names listed, or a suggestion for a mistyped command.
* **Encrypted PDFs** need `password`. Results keep the same password.
* **Signed PDFs**: comments and form values are added as incremental updates,
  so signatures stay valid. Changes that would invalidate a signature are
  refused unless `break_signatures` is set.

## Example session

```
> marmara info contract.pdf --compact
{"ok":true,"command":"info","page_count":4,"signatures":0,"form_fields":6,…}

> marmara search contract.pdf "2025" --compact
{"ok":true,"total":3,"matches":[{"page":1,"text":"2025","context":"…sözleşme 1 Ocak 2025 tarihinde…","rects":[[312.4,188.1,341.2,201.3]]},…]}

> marmara edit-text contract.pdf --find 2025 --replace 2026
{"ok":true,"output":"C:\\docs\\contract.edited.pdf","edits":[{"page":1,"before":"…","after":"…","mode":"in-place","font":"Arial"},…]}

> marmara fill contract.edited.pdf --set "Ad Soyad=Ayşe Yılmaz" --set Onay=true
> marmara sign contract.edited.filled.pdf --id ayse.pfx --id-password … --page 4 --rect 350,700,550,760
```
