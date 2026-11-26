import { create } from "zustand";

export type ZoomMode = "custom" | "fit-width" | "fit-page";

export type Tool =
  | "select"
  | "hand"
  | "highlight"
  | "underline"
  | "strikeout"
  | "ink"
  | "freetext"
  | "note"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "signature"
  | "image"
  | "eraser"
  | "edit-text"
  | "digital-signature";

export type SidebarTab = "pages" | "annotations" | "signatures";

export interface ToolStyle {
  color: string;
  width: number;
  opacity: number;
  fontSize: number;
}

export interface UiState {
  zoom: number;
  zoomMode: ZoomMode;
  /** 0-based index of the page currently in view. */
  currentPage: number;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  tool: Tool;
  toolStyles: Record<string, ToolStyle>;
  fullscreen: boolean;
  /** 0-based page indices selected in the thumbnail sidebar. */
  selectedPages: number[];
  selectionAnchor: number | null;
  /** Annotation selected on the canvas. */
  selectedAnnotation: { pageId: string; id: string } | null;
  dropHover: boolean;
  /** Image/signature waiting to be placed with a click. */
  pendingImage: { dataUrl: string; width: number; height: number; kind: "signature" | "image" } | null;
  /** Annotation whose text is being edited inline. */
  editingAnnotation: string | null;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];

const defaultStyle = (color: string, width = 2, opacity = 1): ToolStyle => ({ color, width, opacity, fontSize: 14 });

export const useUi = create<UiState>(() => ({
  zoom: 1,
  zoomMode: "fit-width",
  currentPage: 0,
  sidebarOpen: true,
  sidebarTab: "pages",
  tool: "select",
  toolStyles: {
    highlight: defaultStyle("#ffd400", 2, 0.45),
    underline: defaultStyle("#1f6feb"),
    strikeout: defaultStyle("#d1242f"),
    ink: defaultStyle("#d1242f", 2.5),
    freetext: defaultStyle("#1f2328"),
    note: defaultStyle("#f2b600"),
    rect: defaultStyle("#d1242f", 2),
    ellipse: defaultStyle("#1f6feb", 2),
    line: defaultStyle("#1f2328", 2),
    arrow: defaultStyle("#d1242f", 2),
  },
  fullscreen: false,
  selectedPages: [],
  selectionAnchor: null,
  selectedAnnotation: null,
  dropHover: false,
  pendingImage: null,
  editingAnnotation: null,
}));

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function zoomStep(current: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > current + 0.001) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((s) => s < current - 0.001) ?? MIN_ZOOM;
}

export function setZoom(zoom: number, mode: ZoomMode = "custom") {
  useUi.setState({ zoom: clampZoom(zoom), zoomMode: mode });
}

export function setTool(tool: Tool) {
  useUi.setState({ tool, selectedAnnotation: null, editingAnnotation: null, ...(tool === "signature" || tool === "image" ? {} : { pendingImage: null }) });
}

export const MARKUP_TOOLS: Tool[] = ["highlight", "underline", "strikeout"];
export const DRAW_TOOLS: Tool[] = ["ink", "rect", "ellipse", "line", "arrow", "freetext", "note", "signature", "image", "digital-signature"];
