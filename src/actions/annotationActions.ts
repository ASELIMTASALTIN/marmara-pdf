import type { Annotation, AnnotationMap } from "../core/annotations/types";
import { newId } from "../core/ids";
import { commitAnnotations, exclusive, useDoc } from "../state/documentStore";
import { useUi } from "../state/uiStore";

const LABELS: Record<Annotation["type"], string> = {
  highlight: "highlight",
  underline: "underline",
  strikeout: "strikethrough",
  redact: "redaction mark",
  ink: "drawing",
  rect: "rectangle",
  ellipse: "ellipse",
  line: "line",
  arrow: "arrow",
  freetext: "text box",
  note: "note",
  signature: "signature",
  image: "image",
};
export const annotationLabel = (t: Annotation["type"]) => LABELS[t];

export function getAuthor(): string {
  return localStorage.getItem("marmara.author") || "";
}

type NewAnnotation = Annotation extends infer A ? (A extends Annotation ? Omit<A, "id" | "createdAt"> : never) : never;

export function addAnnotation(pageId: string, a: NewAnnotation, select = false): Promise<string> {
  const id = newId();
  return exclusive(async () => {
    const { annotations } = useDoc.getState();
    const full = { ...a, id, createdAt: Date.now(), author: getAuthor() || undefined } as Annotation;
    const next: AnnotationMap = { ...annotations, [pageId]: [...(annotations[pageId] ?? []), full] };
    await commitAnnotations(`Add ${LABELS[a.type]}`, next);
    if (select) useUi.setState({ selectedAnnotation: { pageId, id } });
    return id;
  });
}

export function updateAnnotation(pageId: string, id: string, patch: Partial<Annotation>, label?: string): Promise<void> {
  return exclusive(async () => {
    const { annotations } = useDoc.getState();
    const list = annotations[pageId];
    const idx = list?.findIndex((a) => a.id === id) ?? -1;
    if (idx < 0) return;
    const updated = { ...list[idx], ...patch } as Annotation;
    if (JSON.stringify(updated) === JSON.stringify(list[idx])) return;
    const nextList = [...list];
    nextList[idx] = updated;
    await commitAnnotations(label ?? `Edit ${LABELS[updated.type]}`, { ...annotations, [pageId]: nextList });
  });
}

export function deleteAnnotation(pageId: string, id: string): Promise<void> {
  return exclusive(async () => {
    const { annotations } = useDoc.getState();
    const list = annotations[pageId];
    const a = list?.find((x) => x.id === id);
    if (!a) return;
    await commitAnnotations(`Delete ${LABELS[a.type]}`, { ...annotations, [pageId]: list.filter((x) => x.id !== id) });
    const sel = useUi.getState().selectedAnnotation;
    if (sel?.id === id) useUi.setState({ selectedAnnotation: null });
  });
}

export function deleteSelectedAnnotation(): boolean {
  const sel = useUi.getState().selectedAnnotation;
  if (!sel) return false;
  void deleteAnnotation(sel.pageId, sel.id);
  return true;
}

export function findAnnotation(pageId: string, id: string): Annotation | undefined {
  return useDoc.getState().annotations[pageId]?.find((a) => a.id === id);
}

/** Page index of a page id, or -1. */
export function pageIndexOf(pageId: string): number {
  return useDoc.getState().doc?.pageIds.indexOf(pageId) ?? -1;
}
