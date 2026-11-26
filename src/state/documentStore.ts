import { create } from "zustand";
import { openPdf, readPageSizes, type PageSize, type PDFDocumentProxy } from "../core/pdf/pdfjs";
import type { AnnotationMap } from "../core/annotations/types";
import type { FormValues } from "../core/forms/forms";
import { confirm } from "./dialogStore";

/** Thrown when the user cancels an operation in a confirmation dialog. */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}
import { newId } from "../core/ids";

/**
 * Document state. The single source of truth for the document is its PDF
 * bytes; pdf.js renders a proxy loaded from those bytes. Structural edits
 * (page ops, text edits) produce new bytes. Annotations are kept as editable
 * objects keyed by stable page ids and are written into the PDF on save.
 */

export interface DocumentData {
  /** Session id (also used as the recovery snapshot id). */
  id: string;
  name: string;
  /** Path on disk if the document was opened from / saved to a file. */
  path?: string;
  bytes: Uint8Array;
  /** Stable id per page, parallel to the page order. */
  pageIds: string[];
  /** Set when the original file was encrypted; saving re-applies the password. */
  protection?: { userPassword: string };
  /** Bytes as opened (signed documents are saved incrementally on top of them). */
  original?: Uint8Array;
  /** Number of digital signatures in the opened file. */
  signatures?: number;
  /** The user accepted that rewriting edits invalidate the signatures. */
  signatureWarningAccepted?: boolean;
  /** True once the user has confirmed overwriting the original file. */
  overwriteConfirmed?: boolean;
}

interface Snapshot {
  label: string;
  bytes: Uint8Array;
  pageIds: string[];
  annotations: AnnotationMap;
  formValues: FormValues;
}

export interface DocState {
  doc: DocumentData | null;
  pdf: PDFDocumentProxy | null;
  pageSizes: PageSize[];
  /** Increments whenever `pdf` is replaced; used to invalidate render caches. */
  revision: number;
  annotations: AnnotationMap;
  /** Form field values changed by the user (written into the PDF on save). */
  formValues: FormValues;
  dirty: boolean;
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  /** Label of a running long operation, shown as a progress overlay. */
  busy: string | null;
  /** Cancels the running long operation, when it supports cancelling. */
  busyCancel: (() => void) | null;
}

const MAX_UNDO = 40;

export const useDoc = create<DocState>(() => ({
  doc: null,
  pdf: null,
  pageSizes: [],
  revision: 0,
  annotations: {},
  formValues: {},
  dirty: false,
  undoStack: [],
  redoStack: [],
  busy: null,
  busyCancel: null,
}));

// --- serialisation of mutations ---------------------------------------------
let queue: Promise<unknown> = Promise.resolve();

/** Runs document mutations one after another so quick successive edits never race. */
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export async function withBusy<T>(label: string, fn: () => Promise<T>, cancel?: () => void): Promise<T> {
  useDoc.setState({ busy: label, busyCancel: cancel ?? null });
  try {
    return await fn();
  } finally {
    useDoc.setState({ busy: null, busyCancel: null });
  }
}

/** Updates the progress label of the running long operation. */
export function setBusyLabel(label: string) {
  if (useDoc.getState().busy !== null) useDoc.setState({ busy: label });
}

// --- loading -----------------------------------------------------------------
async function loadProxy(bytes: Uint8Array) {
  const pdf = await openPdf(bytes);
  const pageSizes = await readPageSizes(pdf);
  return { pdf, pageSizes };
}

export async function setDocument(input: {
  name: string;
  path?: string;
  bytes: Uint8Array;
  protection?: { userPassword: string };
  dirty?: boolean;
  id?: string;
}): Promise<void> {
  const { pdf, pageSizes } = await loadProxy(input.bytes);
  const prev = useDoc.getState().pdf;
  useDoc.setState((s) => ({
    doc: {
      id: input.id ?? newId(),
      name: input.name,
      path: input.path,
      bytes: input.bytes,
      original: input.bytes,
      pageIds: pageSizes.map(() => newId()),
      protection: input.protection,
    },
    pdf,
    pageSizes,
    revision: s.revision + 1,
    annotations: {},
    formValues: {},
    dirty: input.dirty ?? false,
    undoStack: [],
    redoStack: [],
  }));
  void prev?.loadingTask.destroy();
}

export function closeDocument(): void {
  const prev = useDoc.getState().pdf;
  useDoc.setState((s) => ({
    doc: null,
    pdf: null,
    pageSizes: [],
    revision: s.revision + 1,
    annotations: {},
    formValues: {},
    dirty: false,
    undoStack: [],
    redoStack: [],
  }));
  void prev?.loadingTask.destroy();
}

async function applyState(next: { bytes: Uint8Array; pageIds: string[]; annotations: AnnotationMap; formValues: FormValues }) {
  const s = useDoc.getState();
  if (!s.doc) return;
  if (next.bytes !== s.doc.bytes) {
    const { pdf, pageSizes } = await loadProxy(next.bytes);
    if (pageSizes.length !== next.pageIds.length) {
      void pdf.loadingTask.destroy();
      throw new Error(`Internal error: page count ${pageSizes.length} ≠ ${next.pageIds.length} page ids`);
    }
    const prev = s.pdf;
    useDoc.setState((st) => ({
      doc: st.doc && { ...st.doc, bytes: next.bytes, pageIds: next.pageIds },
      pdf,
      pageSizes,
      revision: st.revision + 1,
      annotations: next.annotations,
      formValues: next.formValues,
    }));
    // Give in-flight renders of the old proxy a moment to settle before destroying it.
    setTimeout(() => void prev?.loadingTask.destroy(), 1500);
  } else {
    useDoc.setState((st) => ({
      doc: st.doc && { ...st.doc, pageIds: next.pageIds },
      annotations: next.annotations,
      formValues: next.formValues,
    }));
  }
}

/**
 * Applies an edit and records an undo step. Omitted fields are unchanged.
 * Changing `bytes` reloads the rendering proxy.
 */
export async function commit(
  label: string,
  change: { bytes?: Uint8Array; pageIds?: string[]; annotations?: AnnotationMap; formValues?: FormValues },
): Promise<void> {
  const s = useDoc.getState();
  if (!s.doc) return;
  // Rewriting the file of a signed document breaks its signatures: ask once.
  if (change.bytes && change.bytes !== s.doc.bytes && s.doc.signatures && !s.doc.signatureWarningAccepted) {
    const ok = await confirm(
      "Document is digitally signed",
      `This change rewrites the document, which invalidates its ${s.doc.signatures} digital signature${s.doc.signatures > 1 ? "s" : ""}. Annotations and form filling keep signatures valid.`,
      { confirmLabel: "Continue and invalidate", danger: true },
    );
    if (!ok) throw new CancelledError();
    useDoc.setState((st) => ({ doc: st.doc && { ...st.doc, signatureWarningAccepted: true } }));
  }
  const snapshot: Snapshot = { label, bytes: s.doc.bytes, pageIds: s.doc.pageIds, annotations: s.annotations, formValues: s.formValues };
  await applyState({
    bytes: change.bytes ?? s.doc.bytes,
    pageIds: change.pageIds ?? s.doc.pageIds,
    annotations: change.annotations ?? s.annotations,
    formValues: change.formValues ?? s.formValues,
  });
  useDoc.setState((st) => ({
    undoStack: [...st.undoStack.slice(-(MAX_UNDO - 1)), snapshot],
    redoStack: [],
    dirty: true,
  }));
}

/** Annotation-only edit (cheap: no re-render of page content). */
export function commitAnnotations(label: string, annotations: AnnotationMap): Promise<void> {
  return commit(label, { annotations });
}

export async function undo(): Promise<string | null> {
  const s = useDoc.getState();
  const snap = s.undoStack[s.undoStack.length - 1];
  if (!s.doc || !snap) return null;
  const current: Snapshot = { label: snap.label, bytes: s.doc.bytes, pageIds: s.doc.pageIds, annotations: s.annotations, formValues: s.formValues };
  await applyState(snap);
  useDoc.setState((st) => ({
    undoStack: st.undoStack.slice(0, -1),
    redoStack: [...st.redoStack, current],
    dirty: true,
  }));
  return snap.label;
}

export async function redo(): Promise<string | null> {
  const s = useDoc.getState();
  const snap = s.redoStack[s.redoStack.length - 1];
  if (!s.doc || !snap) return null;
  const current: Snapshot = { label: snap.label, bytes: s.doc.bytes, pageIds: s.doc.pageIds, annotations: s.annotations, formValues: s.formValues };
  await applyState(snap);
  useDoc.setState((st) => ({
    redoStack: st.redoStack.slice(0, -1),
    undoStack: [...st.undoStack, current],
    dirty: true,
  }));
  return snap.label;
}

/**
 * Replaces the document's baseline bytes and annotations without creating an
 * undo step or marking the document dirty (used when importing editable
 * annotations right after opening).
 */
export async function replaceBaseline(bytes: Uint8Array, annotations: AnnotationMap): Promise<void> {
  const s = useDoc.getState();
  if (!s.doc) return;
  const { pdf, pageSizes } = await loadProxy(bytes);
  if (pageSizes.length !== s.doc.pageIds.length) {
    void pdf.loadingTask.destroy();
    return;
  }
  const prev = s.pdf;
  useDoc.setState((st) => ({
    doc: st.doc && { ...st.doc, bytes },
    pdf,
    pageSizes,
    revision: st.revision + 1,
    annotations,
  }));
  setTimeout(() => void prev?.loadingTask.destroy(), 1500);
}

export function markSaved(patch: Partial<DocumentData>): void {
  useDoc.setState((s) => ({ doc: s.doc && { ...s.doc, ...patch }, dirty: false }));
}
