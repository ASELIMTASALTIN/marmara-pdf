import type { AnnotationMap } from "../core/annotations/types";
import { newId } from "../core/ids";
import { commitAnnotations, useDoc, withBusy } from "../state/documentStore";
import { useUi } from "../state/uiStore";
import { errorMessage, openDialog, toast } from "../state/dialogStore";
import { platform } from "../platform";
import { exportDocument } from "./exportDocument";
import { openFile } from "./fileActions";

/** Compares the current document (new) with an earlier version (old) picked by the user. */
export async function compareWithFile() {
  const { doc } = useDoc.getState();
  if (!doc) return;
  const [old] = await platform.pickPdfs({ multiple: false, title: "Choose the earlier version to compare with" });
  if (!old) return;
  try {
    const current = await exportDocument();
    const { compareDocuments } = await import("../core/compare/compare");
    const result = await withBusy("Comparing documents…", () => compareDocuments(old.bytes, current));
    if (!result.changes.length) {
      await openDialog({
        title: "Compare documents",
        message: `No text differences found between “${old.name}” and “${doc.name}”.`,
        buttons: [{ id: "ok", label: "OK", variant: "primary" }],
      });
      return;
    }
    const r = await openDialog({
      title: "Comparison result",
      message: `${result.insertedWords} word${result.insertedWords === 1 ? "" : "s"} added and ${result.deletedWords} word${result.deletedWords === 1 ? "" : "s"} removed in ${result.changes.length} place${result.changes.length === 1 ? "" : "s"} (${old.name}: ${result.pagesA} pages → ${doc.name}: ${result.pagesB} pages).`,
      body: () => (
        <div className="compare-list">
          {result.changes.slice(0, 200).map((c, i) => (
            <div key={i} className={`compare-item ${c.kind}`}>
              <span className="compare-kind">{c.kind === "inserted" ? "+" : "−"}</span>
              <span className="compare-page">p.{(c.kind === "inserted" ? c.words[0].page : c.anchor?.page ?? 0) + 1}</span>
              <span className="compare-text">{c.text.length > 160 ? c.text.slice(0, 160) + "…" : c.text}</span>
            </div>
          ))}
          {result.changes.length > 200 && <div className="muted small">…and {result.changes.length - 200} more</div>}
        </div>
      ),
      buttons: [
        { id: "close", label: "Close" },
        { id: "mark", label: "Show changes in the document", variant: "primary" },
      ],
      width: 640,
    });
    if (r.button !== "mark") return;
    const ok = await openFile({ name: `Comparison — ${doc.name}`, bytes: current }, { dirty: true });
    if (!ok) return;
    const d = useDoc.getState().doc!;
    const { changesToAnnotations } = await import("../core/compare/markup");
    const map: AnnotationMap = {};
    for (const [page, list] of changesToAnnotations(result, newId)) {
      const id = d.pageIds[page];
      if (id) map[id] = [...(map[id] ?? []), ...list];
    }
    await commitAnnotations("Mark comparison changes", map);
    useUi.setState({ sidebarOpen: true, sidebarTab: "annotations" });
    toast("Added text is highlighted in green; removed text is listed in red notes.", "success", 6000);
  } catch (e) {
    toast(`Comparison failed: ${errorMessage(e)}`, "error");
  }
}
