import type { RefObject } from "react";
import type { PDFPageProxy } from "../../core/pdf/pdfjs";

export interface OverlayProps {
  page: PDFPageProxy;
  pageIndex: number;
  pageId: string;
  zoom: number;
  textDivs: RefObject<HTMLElement[]>;
  textVersion: number;
}

/** Interactive layers drawn above a page (annotations, text editing). */
export function PageOverlays(_props: OverlayProps) {
  return null;
}
