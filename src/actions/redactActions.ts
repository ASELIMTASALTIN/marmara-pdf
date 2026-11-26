import type { AnnotationMap, RedactAnnotation } from "../core/annotations/types";
import { newId } from "../core/ids";
import { commit, commitAnnotations, exclusive, useDoc, withBusy } from "../state/documentStore";
import { errorMessage, openDialog, toast } from "../state/dialogStore";
import { setTool } from "../state/uiStore";

export function redactionMarks(map = useDoc.getState().annotations): { pageId: string; marks: RedactAnnotation[] }[] {
  return Object.entries(map)
    .map(([pageId, list]) => ({ pageId, marks: list.filter((a): a is RedactAnnotation => a.type === "redact") }))
    .filter((x) => x.marks.length);
}

export const countRedactionMarks = (map = useDoc.getState().annotations) =>
  redactionMarks(map).reduce((n, x) => n + x.marks.reduce((k, m) => k + m.rects.length, 0), 0);

/** Marks every occurrence of a phrase for redaction. */
export async function findAndMarkDialog() {
  const { doc } = useDoc.getState();
  if (!doc) return;
  const r = await openDialog({
    title: "Find text to redact",
    message: "Every occurrence is marked. Review the marks, then choose “Apply redactions” to remove the content permanently.",
    fields: [
      { kind: "text", key: "query", label: "Text (e.g. a name, IBAN or ID number)" },
      {
        kind: "radio",
        key: "mode",
        label: "Match",
        value: "any",
        options: [
          { value: "any", label: "Anywhere (also inside longer words)" },
          { value: "word", label: "Whole words only" },
        ],
      },
    ],
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Mark all", variant: "primary" },
    ],
    validate: (v, b) => (b === "ok" && !v.query.trim() ? "Enter the text to find." : null),
  });
  if (r.button !== "ok") return;
  try {
    const { findTextAreas } = await import("../core/redact/redact");
    const areas = await withBusy("Searching…", () => findTextAreas(doc.bytes, r.values.query, r.values.mode === "word"));
    const total = areas.reduce((n, a) => n + a.rects.length, 0);
    if (!total) {
      toast(`“${r.values.query}” was not found`, "info");
      return;
    }
    await exclusive(async () => {
      const { annotations, doc: d } = useDoc.getState();
      if (!d) return;
      const next: AnnotationMap = { ...annotations };
      for (const a of areas) {
        const pageId = d.pageIds[a.pageIndex];
        const mark: RedactAnnotation = { id: newId(), type: "redact", rects: a.rects, text: r.values.query, color: "#d1242f", opacity: 1, createdAt: Date.now() };
        next[pageId] = [...(next[pageId] ?? []), mark];
      }
      await commitAnnotations(`Mark “${r.values.query}” for redaction`, next);
    });
    setTool("redact");
    toast(`Marked ${total} occurrence${total > 1 ? "s" : ""} on ${areas.length} page${areas.length > 1 ? "s" : ""}`, "success");
  } catch (e) {
    toast(errorMessage(e), "error");
  }
}

/** Permanently removes the content under all redaction marks. */
export async function applyRedactionsDialog() {
  const { doc } = useDoc.getState();
  if (!doc) return;
  const n = countRedactionMarks();
  if (!n) {
    toast("There are no redaction marks. Use the Redact tool to mark content first.", "info");
    return;
  }
  const r = await openDialog({
    title: "Apply redactions",
    message: `${n} marked area${n > 1 ? "s" : ""} will be permanently removed: text, image pixels and graphics under the marks are deleted from the file, not just covered. This can be undone until you save.`,
    fields: [
      {
        kind: "radio",
        key: "boxes",
        label: "Removed areas",
        value: "black",
        options: [
          { value: "black", label: "Fill with black boxes" },
          { value: "white", label: "Leave blank" },
        ],
      },
      {
        kind: "select",
        key: "meta",
        label: "Document information",
        value: "remove",
        options: [
          { value: "remove", label: "Also remove metadata (title, author, keywords…)" },
          { value: "keep", label: "Keep metadata" },
        ],
      },
    ],
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Apply redactions", variant: "danger" },
    ],
  });
  if (r.button !== "ok") return;
  await exclusive(async () => {
    try {
      const { doc: d, annotations } = useDoc.getState();
      if (!d) return;
      const marks = redactionMarks(annotations);
      const areas = marks.map((m) => ({ pageIndex: d.pageIds.indexOf(m.pageId), rects: m.marks.flatMap((x) => x.rects) })).filter((a) => a.pageIndex >= 0);
      const { applyRedactions } = await import("../core/redact/redact");
      const bytes = await withBusy("Applying redactions…", () =>
        applyRedactions(d.bytes, areas, { blackBoxes: r.values.boxes === "black", removeMetadata: r.values.meta === "remove" }),
      );
      const remaining: AnnotationMap = {};
      for (const [pid, list] of Object.entries(annotations)) remaining[pid] = list.filter((a) => a.type !== "redact");
      await commit("Apply redactions", { bytes, annotations: remaining });
      setTool("select");
      toast(`Redacted ${n} area${n > 1 ? "s" : ""}. Save the document to make it final.`, "success", 5000);
    } catch (e) {
      toast(`Redaction failed: ${errorMessage(e)}`, "error");
    }
  });
}
