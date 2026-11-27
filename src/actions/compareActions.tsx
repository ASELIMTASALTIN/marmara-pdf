import type { Annotation, AnnotationMap, Rect } from "../core/annotations/types";
import { newId } from "../core/ids";
import { commitAnnotations, useDoc, withBusy } from "../state/documentStore";
import { useUi } from "../state/uiStore";
import { errorMessage, openDialog, toast } from "../state/dialogStore";
import { platform } from "../platform";
import { exportDocument } from "./exportDocument";
import { openFile } from "./fileActions";

/** Groups word rectangles on the same line into one rectangle per line. */
function lineRects(rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of [...rects].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - r[1]) < (r[3] - r[1]) * 0.5 && r[0] - last[2] < (r[3] - r[1]) * 1.5) {
      last[2] = Math.max(last[2], r[2]);
      last[1] = Math.min(last[1], r[1]);
      last[3] = Math.max(last[3], r[3]);
    } else out.push([...r] as Rect);
  }
  return out;
}

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
    const map: AnnotationMap = {};
    const push = (page: number, a: Annotation) => {
      const id = d.pageIds[page];
      if (id) (map[id] ??= []).push(a);
    };
    for (const c of result.changes) {
      if (c.kind === "inserted") {
        const byPage = new Map<number, Rect[]>();
        for (const w of c.words) byPage.set(w.page, [...(byPage.get(w.page) ?? []), w.rect]);
        for (const [page, rects] of byPage)
          push(page, { id: newId(), type: "highlight", rects: lineRects(rects), text: c.text, color: "#2da44e", opacity: 0.4, createdAt: Date.now(), comment: "Added" });
      } else if (c.anchor) {
        push(c.anchor.page, { id: newId(), type: "note", point: [c.anchor.point[0] + 2, c.anchor.point[1] + 4], text: `Removed: ${c.text}`, color: "#ff6b6b", opacity: 1, createdAt: Date.now() });
      }
    }
    await commitAnnotations("Mark comparison changes", map);
    useUi.setState({ sidebarOpen: true, sidebarTab: "annotations" });
    toast("Added text is highlighted in green; removed text is listed in red notes.", "success", 6000);
  } catch (e) {
    toast(`Comparison failed: ${errorMessage(e)}`, "error");
  }
}
