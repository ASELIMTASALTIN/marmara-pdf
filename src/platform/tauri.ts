import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { join } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import { baseName, type OpenedFile, type Platform, type RecoveryEntry } from "./types";

const PDF_FILTER = [{ name: "PDF", extensions: ["pdf"] }];

async function readPath(path: string): Promise<OpenedFile> {
  const buf = await invoke<ArrayBuffer>("read_file", { path });
  return { name: baseName(path), path, bytes: new Uint8Array(buf) };
}

async function writePath(path: string, bytes: Uint8Array): Promise<void> {
  await invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(path) } });
}

export const tauriPlatform: Platform = {
  isDesktop: true,

  async pickPdfs({ multiple, title }) {
    const picked = await open({ multiple, title, filters: PDF_FILTER });
    if (!picked) return [];
    const paths = Array.isArray(picked) ? picked : [picked];
    return Promise.all(paths.map(readPath));
  },

  readPath,

  async savePdf(bytes, { path, suggestedName, saveAs }) {
    let target = saveAs ? null : path ?? null;
    if (!target) {
      target = await save({ defaultPath: suggestedName, filters: PDF_FILTER, title: "Save PDF" });
      if (!target) return null;
      if (!/\.pdf$/i.test(target)) target += ".pdf";
    }
    await writePath(target, bytes);
    return target;
  },

  async saveManyPdfs(files, title) {
    const dir = await open({ directory: true, title });
    if (!dir || Array.isArray(dir)) return null;
    for (const f of files) await writePath(await join(dir, f.name), f.bytes);
    return dir;
  },

  async pickImage() {
    const picked = await open({
      multiple: false,
      title: "Choose image",
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (!picked || Array.isArray(picked)) return null;
    const buf = await invoke<ArrayBuffer>("read_file", { path: picked });
    return { name: baseName(picked), path: picked, bytes: new Uint8Array(buf) };
  },

  startupFile: () => invoke<string | null>("startup_file"),
  fileExists: (path) => invoke<boolean>("file_exists", { path }),
  setFullscreen: (on) => getCurrentWindow().setFullscreen(on),
  setTitle: (title) => getCurrentWindow().setTitle(title),

  onFileDrop(handler, onHover) {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") onHover?.(true);
        else if (p.type === "leave") onHover?.(false);
        else if (p.type === "drop") {
          onHover?.(false);
          const pdfs = p.paths.filter((x) => /\.pdf$/i.test(x));
          if (pdfs.length) handler(await Promise.all(pdfs.map(readPath)));
        }
      })
      .then((u) => (disposed ? u() : (unlisten = u)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  },

  onCloseRequested(handler) {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win
      .onCloseRequested(async (event) => {
        if (!(await handler())) event.preventDefault();
      })
      .then((u) => (disposed ? u() : (unlisten = u)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  },

  recovery: {
    save: (id, name, originalPath, bytes) =>
      invoke("recovery_save", bytes, {
        headers: {
          "x-id": encodeURIComponent(id),
          "x-name": encodeURIComponent(name),
          "x-original-path": encodeURIComponent(originalPath ?? ""),
        },
      }),
    list: () => invoke<RecoveryEntry[]>("recovery_list"),
    read: async (id) => new Uint8Array(await invoke<ArrayBuffer>("recovery_read", { id })),
    remove: (id) => invoke("recovery_delete", { id }),
  },
};
