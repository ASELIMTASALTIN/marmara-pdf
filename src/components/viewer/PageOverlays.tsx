import { useEffect, useMemo, useRef, type RefObject } from "react";
import { CSS_UNITS, type PDFPageProxy } from "../../core/pdf/pdfjs";
import { useUi } from "../../state/uiStore";
import { AnnotationLayer } from "../annotations/AnnotationLayer";
import { TextEditLayer } from "../textedit/TextEditLayer";
import { pageRegistry } from "./pageRegistry";

export interface OverlayProps {
  page: PDFPageProxy;
  pageIndex: number;
  pageId: string;
  zoom: number;
  textDivs: RefObject<HTMLElement[]>;
  textVersion: number;
}

/** Interactive layers drawn above a page (annotations, text editing). */
export function PageOverlays({ page, pageIndex, pageId, zoom }: OverlayProps) {
  const viewport = useMemo(() => page.getViewport({ scale: zoom * CSS_UNITS }), [page, zoom]);
  const anchor = useRef<HTMLSpanElement>(null);
  const tool = useUi((s) => s.tool);

  useEffect(() => {
    const element = anchor.current?.parentElement;
    if (!element) return;
    pageRegistry.set(pageIndex, { index: pageIndex, pageId, viewport, element });
    return () => {
      if (pageRegistry.get(pageIndex)?.pageId === pageId) pageRegistry.delete(pageIndex);
    };
  }, [pageIndex, pageId, viewport]);

  return (
    <>
      <span ref={anchor} hidden />
      <AnnotationLayer viewport={viewport} pageId={pageId} pageIndex={pageIndex} />
      {tool === "edit-text" && <TextEditLayer page={page} viewport={viewport} pageId={pageId} pageIndex={pageIndex} />}
    </>
  );
}
