import { platform, type OpenedFile } from "../platform";
import { openPdf, PasswordRequiredError } from "../core/pdf/pdfjs";
import { looksEncrypted } from "../core/mupdf/security";
import { mergeDocuments } from "../core/pdf/pageOps";
import { exportDocument } from "./exportDocument";
import {
  closeDocument as closeDocState,
  exclusive,
  markSaved,
  replaceBaseline,
  setDocument,
  useDoc,
  withBusy,
} from "../state/documentStore";
import { useUi } from "../state/uiStore";
import { useSearch } from "../state/searchStore";
import { confirm, errorMessage, openDialog, toast } from "../state/dialogStore";

// --- recent files ---------------------------------------------------------------
export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
}
const RECENT_KEY = "marmara.recent";

export function getRecentFiles(): RecentFile[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}
function addRecent(path: string | undefined, name: string) {
  if (!path) return;
  const list = getRecentFiles().filter((r) => r.path !== path);
  list.unshift({ path, name, openedAt: Date.now() });
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)));
  window.dispatchEvent(new Event("marmara:recent"));
}
export function removeRecent(path: string) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(getRecentFiles().filter((r) => r.path !== path)));
  window.dispatchEvent(new Event("marmara:recent"));
}

// --- open -----------------------------------------------------------------------
function resetViewState() {
  useUi.setState({ currentPage: 0, selectedPages: [], selectionAnchor: null, selectedAnnotation: null, tool: "select" });
  useSearch.setState({ hits: [], active: -1, scanned: 0, running: false });
}

async function promptPassword(name: string, incorrect: boolean): Promise<string | null> {
  const r = await openDialog({
    title: "Password required",
    message: incorrect ? `The password for “${name}” is incorrect. Try again.` : `“${name}” is protected. Enter its password to open it.`,
    fields: [{ kind: "text", key: "password", label: "Password", password: true }],
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Open", variant: "primary" },
    ],
  });
  return r.button === "ok" ? r.values.password ?? "" : null;
}

/** Asks to save unsaved changes. Returns false if the user cancelled. */
export async function confirmDiscardChanges(): Promise<boolean> {
  const { doc, dirty } = useDoc.getState();
  if (!doc || !dirty) return true;
  const r = await openDialog({
    title: "Save changes?",
    message: `“${doc.name}” has unsaved changes.`,
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "discard", label: "Don't save", variant: "danger" },
      { id: "save", label: "Save", variant: "primary" },
    ],
  });
  if (r.button === "cancel") return false;
  if (r.button === "save") return saveDocument(false);
  await clearRecovery();
  return true;
}

export async function openFile(file: OpenedFile, opts: { dirty?: boolean; id?: string } = {}): Promise<boolean> {
  if (!(await confirmDiscardChanges())) return false;
  let password: string | undefined;
  for (;;) {
    try {
      await withBusy(`Opening ${file.name}…`, async () => {
        let bytes = file.bytes;
        let protection: { userPassword: string } | undefined;
        // Encrypted files are decrypted into an in-memory working copy so they
        // can be edited; saving re-applies the password.
        if (looksEncrypted(bytes)) {
          await openPdf(bytes, password).then((p) => p.loadingTask.destroy());
          const { decryptPdf } = await import("../core/mupdf/security");
          bytes = await decryptPdf(bytes, password);
          if (password) protection = { userPassword: password };
        }
        await setDocument({ name: file.name, path: file.path, bytes, protection, dirty: opts.dirty, id: opts.id });
      });
      break;
    } catch (e) {
      if (e instanceof PasswordRequiredError) {
        const pw = await promptPassword(file.name, e.incorrect);
        if (pw === null) return false;
        password = pw;
        continue;
      }
      await openDialog({
        title: "Cannot open file",
        message: `“${file.name}” could not be opened. ${errorMessage(e)}`,
        buttons: [{ id: "ok", label: "OK", variant: "primary" }],
      });
      return false;
    }
  }
  resetViewState();
  addRecent(file.path, file.name);
  void importExistingAnnotations();
  void import("./signatureActions").then((m) => m.refreshSignatures());
  return true;
}

/** Restores annotations previously saved by Marmara PDF as editable objects. */
async function importExistingAnnotations(): Promise<void> {
  const { doc, pdf } = useDoc.getState();
  if (!doc || !pdf) return;
  try {
    let found = false;
    for (let i = 1; i <= pdf.numPages && !found; i++) {
      const anns = await (await pdf.getPage(i)).getAnnotations();
      found = anns.some((a: { subtype?: string }) => a.subtype && !["Link", "Widget", "Popup"].includes(a.subtype));
    }
    if (!found) return;
    const { importAnnotations } = await import("../core/annotations/bake");
    const r = await importAnnotations(doc.bytes, doc.pageIds);
    const now = useDoc.getState();
    // Abort if the user already changed or replaced the document meanwhile.
    if (!r || now.doc?.id !== doc.id || now.doc.bytes !== doc.bytes || now.undoStack.length) return;
    await exclusive(() => replaceBaseline(r.bytes, r.annotations));
  } catch (e) {
    console.warn("Annotation import failed", e);
  }
}

export async function openWithPicker(): Promise<void> {
  try {
    const [file] = await platform.pickPdfs({ multiple: false, title: "Open PDF" });
    if (file) await openFile(file);
  } catch (e) {
    toast(errorMessage(e), "error");
  }
}

export async function openPath(path: string): Promise<void> {
  try {
    if (!(await platform.fileExists(path))) {
      toast("That file no longer exists.", "error");
      removeRecent(path);
      return;
    }
    await openFile(await platform.readPath(path));
  } catch (e) {
    toast(errorMessage(e), "error");
  }
}

/** Opens the first dropped file; offers to merge when several are dropped. */
export async function handleDroppedFiles(files: OpenedFile[]): Promise<void> {
  if (files.length === 1) {
    const { doc } = useDoc.getState();
    if (doc) {
      const r = await openDialog({
        title: "Open dropped file",
        message: `What should happen with “${files[0].name}”?`,
        buttons: [
          { id: "cancel", label: "Cancel" },
          { id: "insert", label: "Insert pages at end" },
          { id: "open", label: "Open", variant: "primary" },
        ],
      });
      if (r.button === "insert") {
        const { insertFromFiles } = await import("./pageActions");
        return insertFromFiles(files, useDoc.getState().pageSizes.length);
      }
      if (r.button !== "open") return;
    }
    await openFile(files[0]);
    return;
  }
  await mergeFiles(files);
}

export async function mergeFiles(files: OpenedFile[]): Promise<void> {
  if (files.length < 2) {
    if (files[0]) await openFile(files[0]);
    return;
  }
  try {
    const merged = await withBusy(`Combining ${files.length} files…`, () => mergeDocuments(files.map((f) => f.bytes)));
    await openFile({ name: "Combined.pdf", bytes: merged }, { dirty: true });
    toast(`Combined ${files.length} files`, "success");
  } catch (e) {
    toast(`Could not combine files: ${errorMessage(e)}`, "error");
  }
}

export async function pickAndMerge(): Promise<void> {
  const files = await platform.pickPdfs({ multiple: true, title: "Choose PDFs to combine" });
  if (!files.length) return;
  const { CombineDialog } = await import("../components/home/CombineDialog");
  const ordered = await CombineDialog(files);
  if (ordered) await mergeFiles(ordered);
}

// --- save -----------------------------------------------------------------------
/** Saves the document. Returns true when written. */
export function saveDocument(saveAs: boolean): Promise<boolean> {
  return exclusive(async () => {
    const { doc } = useDoc.getState();
    if (!doc) return false;
    try {
      let target = saveAs ? undefined : doc.path;
      if (target && !doc.overwriteConfirmed) {
        const r = await openDialog({
          title: "Overwrite original?",
          message: `Saving will replace “${doc.name}” on disk. Keep the original by saving a copy instead.`,
          buttons: [
            { id: "cancel", label: "Cancel" },
            { id: "copy", label: "Save a copy…" },
            { id: "overwrite", label: "Overwrite", variant: "primary" },
          ],
        });
        if (r.button === "cancel") return false;
        if (r.button === "copy") target = undefined;
      }
      const bytes = await withBusy("Saving…", () => exportDocument());
      const suggested = target ? doc.name : doc.name.replace(/(\.pdf)?$/i, saveAs && doc.path ? " (edited).pdf" : ".pdf");
      const written = await platform.savePdf(bytes, { path: target, suggestedName: suggested, saveAs: !target });
      if (!written) return false;
      const isPath = platform.isDesktop;
      const name = isPath ? written.split(/[\\/]/).pop()! : doc.name;
      await clearRecovery();
      markSaved({ path: isPath ? written : doc.path, name, overwriteConfirmed: true });
      addRecent(isPath ? written : undefined, name);
      toast(`Saved ${name}`, "success");
      return true;
    } catch (e) {
      toast(`Save failed: ${errorMessage(e)}`, "error");
      return false;
    }
  });
}

export async function closeDocument(): Promise<void> {
  if (!(await confirmDiscardChanges())) return;
  await clearRecovery();
  closeDocState();
  resetViewState();
}

// --- crash recovery --------------------------------------------------------------
async function clearRecovery() {
  const { doc } = useDoc.getState();
  if (doc) await platform.recovery.remove(doc.id).catch(() => {});
}

let lastSnapshotRevision = -1;
/** Writes a recovery snapshot if the document changed since the last one. */
export async function writeRecoverySnapshot(): Promise<void> {
  const s = useDoc.getState();
  if (!s.doc || !s.dirty) return;
  const marker = s.undoStack.length * 100000 + s.revision;
  if (marker === lastSnapshotRevision) return;
  lastSnapshotRevision = marker;
  try {
    const bytes = await exportDocument();
    await platform.recovery.save(s.doc.id, s.doc.name, s.doc.path, bytes);
  } catch (e) {
    console.warn("autosave failed", e);
  }
}

export async function restoreRecovery(id: string, name: string, originalPath?: string | null) {
  try {
    const bytes = await platform.recovery.read(id);
    const ok = await openFile({ name, path: originalPath ?? undefined, bytes }, { dirty: true, id });
    if (ok) toast(`Restored unsaved changes of ${name}`, "success");
  } catch (e) {
    toast(`Could not restore: ${errorMessage(e)}`, "error");
  }
}

export async function discardRecovery(id: string) {
  if (await confirm("Discard recovered document?", "The unsaved changes will be permanently deleted.", { danger: true, confirmLabel: "Discard" }))
    await platform.recovery.remove(id);
}
