/** A file the user picked or dropped, already read into memory. */
export interface OpenedFile {
  name: string;
  /** Absolute path on disk. Undefined when the platform cannot expose it (browser). */
  path?: string;
  bytes: Uint8Array;
}

export interface SaveOptions {
  /** Existing path to overwrite. Ignored when `saveAs` is true. */
  path?: string;
  suggestedName: string;
  saveAs: boolean;
}

export interface RecoveryEntry {
  id: string;
  name: string;
  originalPath?: string | null;
  savedAt: number;
  size: number;
}

/**
 * Everything the UI needs from the host. Implemented by Tauri on desktop and by
 * plain browser APIs for development/testing in a normal browser tab.
 */
export interface Platform {
  readonly isDesktop: boolean;
  pickPdfs(opts: { multiple: boolean; title?: string }): Promise<OpenedFile[]>;
  readPath(path: string): Promise<OpenedFile>;
  /** Returns the path (desktop) or file name (browser) written, or null if cancelled. */
  savePdf(bytes: Uint8Array, opts: SaveOptions): Promise<string | null>;
  /** Writes several files into a user-chosen folder. Returns the folder or null if cancelled. */
  saveManyPdfs(files: { name: string; bytes: Uint8Array }[], title: string): Promise<string | null>;
  pickImage(): Promise<OpenedFile | null>;
  pickImages(): Promise<OpenedFile[]>;
  /** Saves a non-PDF export (docx, png, jpg, txt). Returns the path/name or null if cancelled. */
  saveExport(bytes: Uint8Array, opts: { suggestedName: string; filterName: string; extensions: string[] }): Promise<string | null>;
  /** Writes several export files into a user-chosen folder. */
  saveManyExports(files: { name: string; bytes: Uint8Array }[], title: string): Promise<string | null>;
  startupFile(): Promise<string | null>;
  fileExists(path: string): Promise<boolean>;
  setFullscreen(on: boolean): Promise<void>;
  setTitle(title: string): Promise<void>;
  /** Registers a handler for files dropped onto the window. Returns an unsubscribe function. */
  onFileDrop(handler: (files: OpenedFile[]) => void, onHover?: (hovering: boolean) => void): () => void;
  /**
   * Called before the window closes; return false to keep it open. Browsers
   * cannot run async UI on unload, so they use `hasUnsavedChanges` instead.
   */
  onCloseRequested(handler: () => Promise<boolean>, hasUnsavedChanges: () => boolean): () => void;
  recovery: {
    save(id: string, name: string, originalPath: string | undefined, bytes: Uint8Array): Promise<void>;
    list(): Promise<RecoveryEntry[]>;
    read(id: string): Promise<Uint8Array>;
    remove(id: string): Promise<void>;
  };
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
