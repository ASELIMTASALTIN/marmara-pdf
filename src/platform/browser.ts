import type { OpenedFile, Platform, RecoveryEntry } from "./types";

/**
 * Browser fallback used when the UI runs outside Tauri (e.g. `npm run dev` in a
 * normal browser for UI testing). Files never leave the machine: saving
 * triggers a local download, recovery uses IndexedDB.
 */

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener("cancel", () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

async function toOpened(file: File): Promise<OpenedFile> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// --- tiny IndexedDB key-value store for recovery snapshots -------------------
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("marmara-recovery", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("snapshots");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction("snapshots", mode).objectStore("snapshots"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
type Snapshot = RecoveryEntry & { bytes: Uint8Array };

export const browserPlatform: Platform = {
  isDesktop: false,

  async pickPdfs({ multiple }) {
    return Promise.all((await pickFiles("application/pdf,.pdf", multiple)).map(toOpened));
  },

  async readPath(path) {
    throw new Error(`Cannot read ${path} in browser mode`);
  },

  async savePdf(bytes, { suggestedName }) {
    download(bytes, suggestedName);
    return suggestedName;
  },

  async saveManyPdfs(files) {
    for (const f of files) download(f.bytes, f.name);
    return "Downloads";
  },

  async pickImage() {
    const [file] = await pickFiles("image/png,image/jpeg", false);
    return file ? toOpened(file) : null;
  },

  startupFile: async () => null,
  fileExists: async () => false,

  async setFullscreen(on) {
    if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen().catch(() => {});
    if (!on && document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  },

  async setTitle(title) {
    document.title = title;
  },

  onFileDrop(handler, onHover) {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      onHover?.(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) {
        depth = 0;
        onHover?.(false);
      }
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      onHover?.(false);
      const files = Array.from(e.dataTransfer?.files ?? []).filter(
        (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name),
      );
      if (files.length) handler(await Promise.all(files.map(toOpened)));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  },

  onCloseRequested(_handler, hasUnsavedChanges) {
    const before = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges()) e.preventDefault();
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  },

  recovery: {
    async save(id, name, originalPath, bytes) {
      const snap: Snapshot = { id, name, originalPath, savedAt: Date.now(), size: bytes.length, bytes };
      await tx("readwrite", (s) => s.put(snap, id));
    },
    async list() {
      const all = await tx<Snapshot[]>("readonly", (s) => s.getAll() as IDBRequest<Snapshot[]>);
      return all.map(({ bytes: _b, ...meta }) => meta).sort((a, b) => b.savedAt - a.savedAt);
    },
    async read(id) {
      const snap = await tx<Snapshot | undefined>("readonly", (s) => s.get(id) as IDBRequest<Snapshot | undefined>);
      if (!snap) throw new Error("Recovery snapshot not found");
      return snap.bytes;
    },
    async remove(id) {
      await tx("readwrite", (s) => s.delete(id));
    },
  },
};
