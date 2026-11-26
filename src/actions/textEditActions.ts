import { create } from "zustand";
import type { Point } from "../core/annotations/types";
import type { FontFamily, TextBlockInfo } from "../core/textedit/editor";
import { commit, exclusive, useDoc, withBusy } from "../state/documentStore";
import { errorMessage, toast } from "../state/dialogStore";

/** The single active inline text editor (existing block or new text). */
export interface ActiveTextEdit {
  pageIndex: number;
  /** Existing block being edited; null for new text. */
  block: TextBlockInfo | null;
  /** For new text: baseline origin and direction vectors in PDF space. */
  origin?: Point;
  dir?: Point;
  up?: Point;
  text: string;
  size: number;
  color: string;
  family: FontFamily | "original";
  /** Move in PDF space. */
  dx: number;
  dy: number;
}

interface TextEditState {
  active: ActiveTextEdit | null;
  /** Block lists per page, keyed by `${bytesId}:${page}`. */
  version: number;
}

export const useTextEdit = create<TextEditState>(() => ({ active: null, version: 0 }));

export function startEdit(e: ActiveTextEdit) {
  useTextEdit.setState({ active: e });
}
export function updateEdit(patch: Partial<ActiveTextEdit>) {
  const a = useTextEdit.getState().active;
  if (a) useTextEdit.setState({ active: { ...a, ...patch } });
}
export function cancelEdit() {
  useTextEdit.setState({ active: null });
}

function isUnchanged(a: ActiveTextEdit): boolean {
  if (!a.block) return !a.text.trim();
  return (
    a.text === a.block.text &&
    Math.abs(a.size - a.block.size) < 0.01 &&
    a.color.toLowerCase() === a.block.color.toLowerCase() &&
    (a.family === "original" || a.family === a.block.family) &&
    Math.abs(a.dx) < 0.01 &&
    Math.abs(a.dy) < 0.01
  );
}

/** Applies the active edit to the document (one undo step). */
export function commitEdit(): Promise<void> {
  const a = useTextEdit.getState().active;
  useTextEdit.setState({ active: null });
  if (!a || isUnchanged(a)) return Promise.resolve();
  return exclusive(async () => {
    const { doc } = useDoc.getState();
    if (!doc) return;
    try {
      const { applyTextEdit, insertText } = await import("../core/textedit/editor");
      if (!a.block) {
        const r = await withBusy("Adding text…", () =>
          insertText(doc.bytes, a.pageIndex, {
            origin: [a.origin![0] + a.dx, a.origin![1] + a.dy],
            dir: a.dir!,
            up: a.up!,
            text: a.text,
            size: a.size,
            color: a.color,
            family: a.family === "original" ? "sans" : a.family,
          }),
        );
        await commit("Add text", { bytes: r.bytes });
        toast("Text added to the page", "success");
        return;
      }
      const r = await withBusy("Editing text…", () =>
        applyTextEdit(doc.bytes, a.pageIndex, {
          blockId: a.block!.id,
          text: a.text,
          size: a.size,
          color: a.color,
          family: a.family === "original" ? undefined : a.family,
          dx: a.dx,
          dy: a.dy,
        }),
      );
      await commit(r.mode === "deleted" ? "Delete text" : "Edit text", { bytes: r.bytes });
      if (r.mode === "in-place") toast(`Text edited in its original font (${r.font})`, "success");
      else if (r.mode === "reflowed")
        toast(
          !r.substituted
            ? `Paragraph re-flowed in its original font (${r.font})`
            : `Paragraph re-flowed with ${r.font}${a.family !== "original" && a.family !== a.block.family ? "" : " because the original font does not contain every character"}`,
          "success",
          5000,
        );
      else if (r.mode === "deleted") toast("Text deleted", "success");
      else {
        const why =
          a.family !== "original" && a.family !== a.block.family
            ? "with the chosen font"
            : Math.abs(a.dx) > 0.01 || Math.abs(a.dy) > 0.01
              ? "at its new position"
              : "because the original font does not contain every character";
        toast(`Text re-typeset ${why} (${r.font})`, "info", 5000);
      }
    } catch (e) {
      toast(`Text edit failed: ${errorMessage(e)}`, "error");
    }
  });
}

export function deleteActiveBlock(): Promise<void> {
  const a = useTextEdit.getState().active;
  if (!a?.block) {
    cancelEdit();
    return Promise.resolve();
  }
  useTextEdit.setState({ active: { ...a, text: "" } });
  return commitEdit();
}
