import * as ops from "../core/pdf/pageOps";
import { newId } from "../core/ids";
import type { AnnotationMap } from "../core/annotations/types";
import { commit, exclusive, useDoc, withBusy } from "../state/documentStore";
import { useUi } from "../state/uiStore";
import { errorMessage, openDialog, toast } from "../state/dialogStore";
import { platform, type OpenedFile } from "../platform";
import { viewer } from "../components/viewer/viewerController";

/** Pages an operation applies to: the sidebar selection, else the current page. */
export function targetPages(): number[] {
  const { selectedPages, currentPage } = useUi.getState();
  const n = useDoc.getState().pageSizes.length;
  const sel = selectedPages.filter((i) => i >= 0 && i < n);
  return sel.length ? [...sel].sort((a, b) => a - b) : [currentPage];
}

function selectPages(indices: number[]) {
  useUi.setState({ selectedPages: indices, selectionAnchor: indices[0] ?? null });
}

/** Runs a page operation exclusively with error reporting. */
function run(label: string, fn: () => Promise<void>): Promise<void> {
  return exclusive(async () => {
    try {
      await withBusy(label, fn);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  });
}

function cloneAnnotationsFor(src: AnnotationMap, fromId: string, toId: string): AnnotationMap {
  const list = src[fromId];
  if (!list?.length) return src;
  return { ...src, [toId]: list.map((a) => ({ ...a, id: newId() })) };
}

export function rotate(delta: 90 | -90 | 180, indices = targetPages()) {
  return run("Rotating pages…", async () => {
    const { doc } = useDoc.getState();
    if (!doc) return;
    await commit(delta > 0 ? "Rotate right" : "Rotate left", { bytes: await ops.rotatePages(doc.bytes, indices, delta) });
  });
}

export async function deletePagesAction(indices = targetPages()) {
  const { doc } = useDoc.getState();
  if (!doc) return;
  if (indices.length >= doc.pageIds.length) {
    toast("A PDF must keep at least one page.", "error");
    return;
  }
  return run("Deleting pages…", async () => {
    const { doc, annotations } = useDoc.getState();
    if (!doc) return;
    const remove = new Set(indices);
    const pageIds = doc.pageIds.filter((_, i) => !remove.has(i));
    const next = { ...annotations };
    indices.forEach((i) => delete next[doc.pageIds[i]]);
    await commit(indices.length > 1 ? `Delete ${indices.length} pages` : "Delete page", {
      bytes: await ops.deletePages(doc.bytes, indices),
      pageIds,
      annotations: next,
    });
    selectPages([]);
    useUi.setState({ currentPage: Math.min(useUi.getState().currentPage, pageIds.length - 1) });
  });
}

export function duplicate(indices = targetPages()) {
  return run("Duplicating pages…", async () => {
    const { doc, annotations } = useDoc.getState();
    if (!doc) return;
    const sorted = [...new Set(indices)].sort((a, b) => a - b);
    const pageIds: string[] = [];
    let anns = annotations;
    const newPositions: number[] = [];
    doc.pageIds.forEach((id, i) => {
      pageIds.push(id);
      if (sorted.includes(i)) {
        const copy = newId();
        anns = cloneAnnotationsFor(anns, id, copy);
        newPositions.push(pageIds.length);
        pageIds.push(copy);
      }
    });
    await commit("Duplicate pages", { bytes: await ops.duplicatePages(doc.bytes, sorted), pageIds, annotations: anns });
    selectPages(newPositions);
  });
}

/** Moves pages so they land before original index `target` (0..n). */
export function movePages(indices: number[], target: number) {
  return run("Reordering pages…", async () => {
    const { doc } = useDoc.getState();
    if (!doc) return;
    const order = ops.computeMoveOrder(doc.pageIds.length, indices, target);
    if (order.every((v, i) => v === i)) return;
    await commit("Reorder pages", { bytes: await ops.reorderPages(doc.bytes, order), pageIds: order.map((i) => doc.pageIds[i]) });
    const moved = new Set(indices);
    selectPages(order.map((old, i) => (moved.has(old) ? i : -1)).filter((i) => i >= 0));
  });
}

export function insertBlank(at: number) {
  return run("Inserting page…", async () => {
    const { doc } = useDoc.getState();
    if (!doc) return;
    const pageIds = [...doc.pageIds];
    pageIds.splice(at, 0, newId());
    await commit("Insert blank page", { bytes: await ops.insertBlankPage(doc.bytes, at), pageIds });
    selectPages([at]);
    viewer.scrollToPage(at);
  });
}

export function insertFromFiles(files: OpenedFile[], at: number) {
  return run("Inserting pages…", async () => {
    let { doc } = useDoc.getState();
    if (!doc) return;
    let bytes = doc.bytes;
    let pos = at;
    const added: string[] = [];
    for (const f of files) {
      const r = await ops.insertPagesFrom(bytes, pos, f.bytes);
      bytes = r.bytes;
      for (let k = 0; k < r.inserted; k++) added.push(newId());
      pos += r.inserted;
    }
    doc = useDoc.getState().doc!;
    const pageIds = [...doc.pageIds];
    pageIds.splice(at, 0, ...added);
    await commit(`Insert ${added.length} pages`, { bytes, pageIds });
    selectPages(added.map((_, k) => at + k));
    viewer.scrollToPage(at);
    toast(`Inserted ${added.length} page${added.length === 1 ? "" : "s"}`, "success");
  });
}

export async function insertFromFilePicker(at: number) {
  const files = await platform.pickPdfs({ multiple: true, title: "Choose PDF to insert" });
  if (files.length) await insertFromFiles(files, at);
}

const stem = (name: string) => name.replace(/\.pdf$/i, "");

export async function extract(indices = targetPages()) {
  const { doc } = useDoc.getState();
  if (!doc) return;
  try {
    const bytes = await withBusy("Extracting pages…", () => ops.extractPages(doc.bytes, indices));
    const label = indices.length === 1 ? `p${indices[0] + 1}` : `p${indices[0] + 1}-${indices[indices.length - 1] + 1}`;
    const written = await platform.savePdf(bytes, { suggestedName: `${stem(doc.name)} (${label}).pdf`, saveAs: true });
    if (written) toast(`Extracted ${indices.length} page${indices.length === 1 ? "" : "s"}`, "success");
  } catch (e) {
    toast(`Extract failed: ${errorMessage(e)}`, "error");
  }
}

export async function splitDialog() {
  const { doc, pageSizes } = useDoc.getState();
  if (!doc) return;
  const n = pageSizes.length;
  const r = await openDialog({
    title: "Split document",
    message: `“${doc.name}” has ${n} pages. The parts are saved as separate files; this document is not changed.`,
    fields: [
      {
        kind: "radio",
        key: "mode",
        label: "Split method",
        value: "every",
        options: [
          { value: "every", label: "Every N pages" },
          { value: "points", label: "Before specific pages", hint: "e.g. 4, 9 → 1–3, 4–8, 9–end" },
          { value: "ranges", label: "Custom ranges", hint: "e.g. 1-3; 4-10; 11-" },
        ],
      },
      { kind: "text", key: "value", label: "Value", value: "1", placeholder: "1" },
    ],
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Split…", variant: "primary" },
    ],
    validate: (v, b) => {
      if (b !== "ok") return null;
      try {
        buildRanges(v.mode, v.value, n);
        return null;
      } catch (e) {
        return errorMessage(e);
      }
    },
  });
  if (r.button !== "ok") return;
  const ranges = buildRanges(r.values.mode, r.values.value, n);
  try {
    const parts = await withBusy(`Splitting into ${ranges.length} files…`, () => ops.splitDocument(doc.bytes, ranges));
    const width = String(parts.length).length;
    const files = parts.map((bytes, k) => ({
      name: `${stem(doc.name)} - part ${String(k + 1).padStart(width, "0")} (p${ranges[k][0] + 1}-${ranges[k][ranges[k].length - 1] + 1}).pdf`,
      bytes,
    }));
    const dir = await platform.saveManyPdfs(files, "Choose a folder for the split files");
    if (dir) toast(`Saved ${files.length} files to ${dir}`, "success");
  } catch (e) {
    toast(`Split failed: ${errorMessage(e)}`, "error");
  }
}

function buildRanges(mode: string, value: string, n: number): number[][] {
  if (mode === "every") {
    const k = parseInt(value, 10);
    if (!(k >= 1)) throw new Error("Enter a number of pages ≥ 1");
    if (k >= n) throw new Error(`The document only has ${n} pages`);
    return ops.rangesEvery(n, k);
  }
  if (mode === "points") {
    const pts = value.split(/[,\s]+/).filter(Boolean).map((s) => parseInt(s, 10));
    if (!pts.length || pts.some((p) => !(p >= 2 && p <= n))) throw new Error(`Split points must be pages between 2 and ${n}`);
    return ops.rangesAtSplitPoints(n, pts);
  }
  const ranges = value.split(";").map((s) => s.trim()).filter(Boolean).map((s) => ops.parsePageRanges(s, n));
  if (!ranges.length) throw new Error("Enter at least one range");
  return ranges;
}
