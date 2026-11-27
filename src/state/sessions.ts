import { create } from "zustand";
import { useDoc, type DocState } from "./documentStore";
import { useUi, type UiState } from "./uiStore";
import { useSearch } from "./searchStore";

/**
 * Multiple open documents (tabs). The active document lives in `useDoc`;
 * inactive ones are parked here with their view state and swapped in on
 * switch, so every component keeps reading a single store.
 */

type DocSnapshot = Pick<DocState, "doc" | "pdf" | "pageSizes" | "revision" | "annotations" | "formValues" | "dirty" | "undoStack" | "redoStack">;
type ViewSnapshot = Pick<UiState, "zoom" | "zoomMode" | "currentPage" | "selectedPages" | "sidebarTab">;

interface Parked {
  doc: DocSnapshot;
  view: ViewSnapshot;
}

export interface TabInfo {
  id: string;
  name: string;
  dirty: boolean;
}

interface SessionState {
  /** Tab order (document ids); includes the active document. */
  order: string[];
  parked: Record<string, Parked>;
}

export const useSessions = create<SessionState>(() => ({ order: [], parked: {} }));

export function captureDoc(): DocSnapshot {
  const s = useDoc.getState();
  return {
    doc: s.doc,
    pdf: s.pdf,
    pageSizes: s.pageSizes,
    revision: s.revision,
    annotations: s.annotations,
    formValues: s.formValues,
    dirty: s.dirty,
    undoStack: s.undoStack,
    redoStack: s.redoStack,
  };
}

function captureView(): ViewSnapshot {
  const u = useUi.getState();
  return { zoom: u.zoom, zoomMode: u.zoomMode, currentPage: u.currentPage, selectedPages: u.selectedPages, sidebarTab: u.sidebarTab };
}

function resetTransient() {
  useUi.setState({ selectedAnnotation: null, editingAnnotation: null, tool: "select", selectionAnchor: null, pendingImage: null });
  useSearch.setState({ hits: [], active: -1, running: false, scanned: 0 });
}

/** Parks the active document (before another document becomes active). */
export function parkActive(snapshot: DocSnapshot = captureDoc()) {
  const id = snapshot.doc?.id;
  if (!id) return;
  useSessions.setState((s) => ({
    parked: { ...s.parked, [id]: { doc: snapshot, view: captureView() } },
    order: s.order.includes(id) ? s.order : [...s.order, id],
  }));
}

/** Registers the currently active document as a tab (after opening). */
export function registerActive() {
  const id = useDoc.getState().doc?.id;
  if (!id) return;
  useSessions.setState((s) => {
    const parked = { ...s.parked };
    delete parked[id];
    return { parked, order: s.order.includes(id) ? s.order : [...s.order, id] };
  });
}

export function switchTo(id: string) {
  const active = useDoc.getState().doc?.id;
  if (id === active) return;
  const target = useSessions.getState().parked[id];
  if (!target) return;
  parkActive();
  useSessions.setState((s) => {
    const parked = { ...s.parked };
    delete parked[id];
    return { parked };
  });
  resetTransient();
  useDoc.setState({ ...target.doc });
  useUi.setState({ ...target.view });
}

/** Removes the active tab and activates a neighbour (or shows the start screen). */
export function dropActive(): boolean {
  const s = useSessions.getState();
  const active = useDoc.getState().doc?.id;
  const idx = active ? s.order.indexOf(active) : -1;
  const order = s.order.filter((x) => x !== active);
  useSessions.setState({ order });
  const nextId = order[Math.min(Math.max(idx, 0), order.length - 1)];
  if (nextId && s.parked[nextId]) {
    const target = s.parked[nextId];
    const parked = { ...s.parked };
    delete parked[nextId];
    useSessions.setState({ parked });
    resetTransient();
    useDoc.setState({ ...target.doc });
    useUi.setState({ ...target.view });
    return true;
  }
  return false;
}

export function tabs(): TabInfo[] {
  const s = useSessions.getState();
  const d = useDoc.getState();
  return s.order
    .map((id) => {
      if (d.doc?.id === id) return { id, name: d.doc.name, dirty: d.dirty };
      const p = s.parked[id];
      return p?.doc.doc ? { id, name: p.doc.doc.name, dirty: p.doc.dirty } : null;
    })
    .filter((t): t is TabInfo => !!t);
}

/** Ids of parked documents with unsaved changes. */
export function dirtyParked(): string[] {
  const s = useSessions.getState();
  return Object.values(s.parked)
    .filter((p) => p.doc.dirty && p.doc.doc)
    .map((p) => p.doc.doc!.id);
}
