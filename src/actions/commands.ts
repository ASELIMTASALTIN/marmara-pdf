import { closeDocument, openWithPicker, pickAndMerge, saveDocument } from "./fileActions";
import { deletePagesAction, extract, insertBlank, insertFromFilePicker, rotate, splitDialog, targetPages } from "./pageActions";
import { nextHit } from "./searchActions";
import { exclusive, redo, undo, useDoc } from "../state/documentStore";
import { setTool, setZoom, useUi, zoomStep, type Tool } from "../state/uiStore";
import { useSearch } from "../state/searchStore";
import { openDialog, toast } from "../state/dialogStore";
import { platform } from "../platform";
import { activateTool } from "./toolActions";
import { deleteSelectedAnnotation } from "./annotationActions";
import { viewer } from "../components/viewer/viewerController";

export interface Command {
  id: string;
  label: string;
  /** Display form, e.g. "Ctrl+Shift+S". */
  shortcut?: string;
  /** Extra key bindings that trigger the command (not displayed). */
  keys?: string[];
  needsDoc?: boolean;
  run: () => unknown;
}

const hasDoc = () => !!useDoc.getState().doc;

export async function toggleFullscreen(on = !useUi.getState().fullscreen) {
  useUi.setState({ fullscreen: on, ...(on ? { zoomMode: "fit-page" as const } : {}) });
  await platform.setFullscreen(on).catch(() => {});
}

export async function goToPageDialog() {
  const n = useDoc.getState().pageSizes.length;
  const r = await openDialog({
    title: "Go to page",
    fields: [{ kind: "number", key: "page", label: `Page (1–${n})`, value: useUi.getState().currentPage + 1, min: 1, max: n }],
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Go", variant: "primary" },
    ],
  });
  const p = parseInt(r.values.page, 10);
  if (r.button === "ok" && p >= 1 && p <= n) viewer.scrollToPage(p - 1);
}

export function openSearch() {
  useSearch.setState({ open: true });
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>("#search-input");
    input?.focus();
    input?.select();
  });
}

/** Escape: leave editing / deselect / back to Select tool / leave full screen. */
function escape() {
  const ui = useUi.getState();
  if (ui.editingAnnotation) useUi.setState({ editingAnnotation: null });
  else if (ui.selectedAnnotation) useUi.setState({ selectedAnnotation: null });
  else if (ui.tool !== "select") setTool("select");
  else if (ui.fullscreen) void toggleFullscreen(false);
}

const page = (delta: number) => () => viewer.scrollToPage(useUi.getState().currentPage + delta);
const tool = (t: Tool) => () => activateTool(t);

export const commands: Command[] = [
  { id: "file.open", label: "Open…", shortcut: "Ctrl+O", run: openWithPicker },
  { id: "file.save", label: "Save", shortcut: "Ctrl+S", needsDoc: true, run: () => saveDocument(false) },
  { id: "file.saveAs", label: "Save as…", shortcut: "Ctrl+Shift+S", needsDoc: true, run: () => saveDocument(true) },
  { id: "file.close", label: "Close document", shortcut: "Ctrl+W", needsDoc: true, run: closeDocument },
  { id: "file.combine", label: "Combine files…", run: pickAndMerge },
  { id: "file.print", label: "Print…", shortcut: "Ctrl+P", needsDoc: true, run: () => import("./printActions").then((m) => m.printDialog()) },
  { id: "tools.compress", label: "Reduce file size…", needsDoc: true, run: () => import("./optimizeActions").then((m) => m.compressDialog()) },
  { id: "tools.check", label: "Document check (accessibility, PDF/A)…", needsDoc: true, run: () => import("./optimizeActions").then((m) => m.documentCheckDialog()) },
  { id: "tools.pdfa", label: "Save as PDF/A…", needsDoc: true, run: () => import("./optimizeActions").then((m) => m.saveAsPdfA()) },
  { id: "stamp.headerFooter", label: "Header, footer & page numbers…", needsDoc: true, run: () => import("./stampActions").then((m) => m.headerFooterDialog()) },
  { id: "stamp.watermark", label: "Watermark…", needsDoc: true, run: () => import("./stampActions").then((m) => m.watermarkDialog()) },
  { id: "stamp.bates", label: "Bates numbering…", needsDoc: true, run: () => import("./stampActions").then((m) => m.batesDialog()) },
  { id: "stamp.remove", label: "Remove headers, footers & watermarks", needsDoc: true, run: () => import("./stampActions").then((m) => m.removeStampsAction()) },
  { id: "redact.find", label: "Find & mark for redaction…", needsDoc: true, run: () => import("./redactActions").then((m) => m.findAndMarkDialog()) },
  { id: "redact.apply", label: "Apply redactions…", needsDoc: true, run: () => import("./redactActions").then((m) => m.applyRedactionsDialog()) },
  { id: "file.fromImages", label: "Create PDF from images…", run: () => import("./convertActions").then((m) => m.createPdfFromImages()) },
  { id: "export.word", label: "Export to Word (.docx)…", needsDoc: true, run: () => import("./convertActions").then((m) => m.exportToWord()) },
  { id: "export.images", label: "Export pages as images…", needsDoc: true, run: () => import("./convertActions").then((m) => m.exportToImages()) },
  { id: "export.text", label: "Export as plain text…", needsDoc: true, run: () => import("./convertActions").then((m) => m.exportToText()) },

  {
    id: "edit.undo",
    label: "Undo",
    shortcut: "Ctrl+Z",
    needsDoc: true,
    run: () => exclusive(async () => {
      const l = await undo();
      if (l) toast(`Undid: ${l}`);
    }),
  },
  {
    id: "edit.redo",
    label: "Redo",
    shortcut: "Ctrl+Y",
    keys: ["Ctrl+Shift+Z"],
    needsDoc: true,
    run: () => exclusive(async () => {
      const l = await redo();
      if (l) toast(`Redid: ${l}`);
    }),
  },

  { id: "view.zoomIn", label: "Zoom in", shortcut: "Ctrl+=", keys: ["Ctrl++", "Ctrl+Shift+="], needsDoc: true, run: () => setZoom(zoomStep(useUi.getState().zoom, 1)) },
  { id: "view.zoomOut", label: "Zoom out", shortcut: "Ctrl+-", needsDoc: true, run: () => setZoom(zoomStep(useUi.getState().zoom, -1)) },
  { id: "view.actualSize", label: "Actual size", shortcut: "Ctrl+1", needsDoc: true, run: () => setZoom(1) },
  { id: "view.fitWidth", label: "Fit width", shortcut: "Ctrl+2", needsDoc: true, run: () => useUi.setState({ zoomMode: "fit-width" }) },
  { id: "view.fitPage", label: "Fit page", shortcut: "Ctrl+0", needsDoc: true, run: () => useUi.setState({ zoomMode: "fit-page" }) },
  { id: "view.fullscreen", label: "Full-screen reading", shortcut: "F11", needsDoc: true, run: () => toggleFullscreen() },
  { id: "view.escape", label: "Cancel", keys: ["Escape"], run: escape },
  { id: "view.sidebar", label: "Toggle sidebar", shortcut: "F4", run: () => useUi.setState((s) => ({ sidebarOpen: !s.sidebarOpen })) },

  { id: "nav.next", label: "Next page", shortcut: "PageDown", keys: ["ArrowRight", "Ctrl+ArrowDown"], needsDoc: true, run: page(1) },
  { id: "nav.prev", label: "Previous page", shortcut: "PageUp", keys: ["ArrowLeft", "Ctrl+ArrowUp"], needsDoc: true, run: page(-1) },
  { id: "nav.first", label: "First page", shortcut: "Home", needsDoc: true, run: () => viewer.scrollToPage(0) },
  { id: "nav.last", label: "Last page", shortcut: "End", needsDoc: true, run: () => viewer.scrollToPage(useDoc.getState().pageSizes.length - 1) },
  { id: "nav.goto", label: "Go to page…", shortcut: "Ctrl+G", needsDoc: true, run: goToPageDialog },

  { id: "search.open", label: "Find", shortcut: "Ctrl+F", needsDoc: true, run: openSearch },
  { id: "search.next", label: "Find next", shortcut: "F3", keys: ["Enter@search"], needsDoc: true, run: () => nextHit(1) },
  { id: "search.prev", label: "Find previous", shortcut: "Shift+F3", needsDoc: true, run: () => nextHit(-1) },

  { id: "edit.delete", label: "Delete selection", keys: ["Delete", "Backspace"], needsDoc: true, run: deleteSelectedAnnotation },
  { id: "page.rotateRight", label: "Rotate right", shortcut: "Ctrl+R", needsDoc: true, run: () => rotate(90) },
  { id: "page.rotateLeft", label: "Rotate left", shortcut: "Ctrl+Shift+R", needsDoc: true, run: () => rotate(-90) },
  { id: "page.delete", label: "Delete pages", needsDoc: true, run: () => deletePagesAction() },
  { id: "page.insertBlank", label: "Insert blank page", needsDoc: true, run: () => insertBlank(Math.max(...targetPages()) + 1) },
  { id: "page.insertFile", label: "Insert from file…", needsDoc: true, run: () => insertFromFilePicker(Math.max(...targetPages()) + 1) },
  { id: "page.extract", label: "Extract pages…", needsDoc: true, run: () => extract() },
  { id: "page.split", label: "Split document…", needsDoc: true, run: splitDialog },

  { id: "sign.document", label: "Sign digitally…", needsDoc: true, run: () => import("./signatureActions").then((m) => m.signDocumentFlow()) },
  { id: "sign.ids", label: "Manage digital IDs…", run: () => import("../components/signatures/DigitalIdsDialog").then((m) => m.digitalIdsDialog()) },
  { id: "sign.panel", label: "Signatures", needsDoc: true, run: () => useUi.setState({ sidebarOpen: true, sidebarTab: "signatures" }) },
  { id: "ocr.run", label: "Recognise text (OCR)…", needsDoc: true, run: () => import("./ocrActions").then((m) => m.ocrDialog()) },
  { id: "tool.select", label: "Select", shortcut: "V", needsDoc: true, run: () => setTool("select") },
  { id: "tool.hand", label: "Hand", shortcut: "H", needsDoc: true, run: tool("hand") },
  { id: "tool.highlight", label: "Highlight", shortcut: "U", needsDoc: true, run: tool("highlight") },
  { id: "tool.ink", label: "Draw", shortcut: "D", needsDoc: true, run: tool("ink") },
  { id: "tool.freetext", label: "Text box", shortcut: "X", needsDoc: true, run: tool("freetext") },
  { id: "tool.note", label: "Sticky note", shortcut: "N", needsDoc: true, run: tool("note") },
  { id: "tool.rect", label: "Rectangle", shortcut: "R", needsDoc: true, run: tool("rect") },
  { id: "tool.eraser", label: "Eraser", shortcut: "E", needsDoc: true, run: tool("eraser") },
  { id: "tool.editText", label: "Edit text", shortcut: "T", needsDoc: true, run: tool("edit-text") },
];

export const commandById = new Map(commands.map((c) => [c.id, c]));

export function runCommand(id: string) {
  const c = commandById.get(id);
  if (!c || (c.needsDoc && !hasDoc())) return;
  void c.run();
}
