import type { PageViewport } from "../../core/pdf/pdfjs";

/** Mounted pages, so selection-based tools can map screen rects onto any page. */
export interface MountedPage {
  index: number;
  pageId: string;
  viewport: PageViewport;
  element: HTMLElement;
}

export const pageRegistry = new Map<number, MountedPage>();
