import type { PDFPageProxy, PageViewport } from "../../core/pdf/pdfjs";

export interface TextEditLayerProps {
  page: PDFPageProxy;
  viewport: PageViewport;
  pageId: string;
  pageIndex: number;
}

/** Text editing overlay (implemented in the text-editing phase). */
export function TextEditLayer(_props: TextEditLayerProps) {
  return null;
}
