import type { AnnotationMap } from "../core/annotations/types";
import { countAnnotations } from "../core/annotations/types";
import { newId } from "../core/ids";
import { commitAnnotations, exclusive, useDoc } from "../state/documentStore";
import { useUi } from "../state/uiStore";
import { errorMessage, toast } from "../state/dialogStore";
import { platform } from "../platform";

/** Exports the document's comments as XFDF (for reviewers / Acrobat). */
export async function exportComments() {
  const { doc, annotations } = useDoc.getState();
  if (!doc) return;
  if (!countAnnotations(annotations)) {
    toast("This document has no comments to export.", "info");
    return;
  }
  const { exportXfdf } = await import("../core/annotations/xfdf");
  const xml = exportXfdf(annotations, doc.pageIds, doc.name);
  const written = await platform.saveExport(new TextEncoder().encode(xml), {
    suggestedName: `${doc.name.replace(/\.pdf$/i, "")} (comments).xfdf`,
    filterName: "XFDF comments",
    extensions: ["xfdf"],
  });
  if (written) toast("Comments exported. Reviewers can import the file into their copy of the PDF.", "success", 5000);
}

/** Imports comments from an XFDF file into the current document. */
export async function importComments() {
  const { doc } = useDoc.getState();
  if (!doc) return;
  const file = await platform.pickFile({ title: "Import comments", filterName: "XFDF comments", extensions: ["xfdf", "xml"] });
  if (!file) return;
  await exclusive(async () => {
    try {
      const { importXfdf } = await import("../core/annotations/xfdf");
      const { byPage, count, skipped } = importXfdf(new TextDecoder().decode(file.bytes), newId);
      const { doc: d, annotations } = useDoc.getState();
      if (!d) return;
      const next: AnnotationMap = { ...annotations };
      let outside = 0;
      for (const [page, list] of byPage) {
        const pid = d.pageIds[page];
        if (!pid) {
          outside += list.length;
          continue;
        }
        next[pid] = [...(next[pid] ?? []), ...list];
      }
      if (count - outside <= 0) {
        toast("The file contains no comments that fit this document.", "info");
        return;
      }
      await commitAnnotations(`Import ${count - outside} comments`, next);
      useUi.setState({ sidebarOpen: true, sidebarTab: "annotations" });
      const notes = [skipped && `${skipped} unsupported`, outside && `${outside} on pages that do not exist`].filter(Boolean).join(", ");
      toast(`Imported ${count - outside} comment${count - outside === 1 ? "" : "s"}${notes ? ` (${notes} skipped)` : ""}`, "success", 5000);
    } catch (e) {
      toast(`Import failed: ${errorMessage(e)}`, "error");
    }
  });
}
