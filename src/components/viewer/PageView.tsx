import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  CSS_UNITS,
  pdfjs,
  TEXT_CONTENT_OPTIONS,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "../../core/pdf/pdfjs";
import { rangeToSegments } from "../../core/search/textSearch";
import { useSearch } from "../../state/searchStore";
import { getPageText } from "../../actions/searchActions";
import { viewer } from "./viewerController";
import { PageOverlays } from "./PageOverlays";

const MAX_CANVAS_PIXELS = 16_777_216; // 4096²: keeps memory bounded at high zoom

interface Props {
  pdf: PDFDocumentProxy;
  index: number;
  pageId: string;
  zoom: number;
  width: number;
  height: number;
  top: number;
  left: number;
}

interface HighlightRect {
  x: number;
  y: number;
  w: number;
  h: number;
  active: boolean;
}

export const PageView = memo(function PageView({ pdf, index, pageId, zoom, width, height, top, left }: Props) {
  const pageDivRef = useRef<HTMLDivElement>(null);
  const canvasHolder = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const textDivs = useRef<HTMLElement[]>([]);
  const textLayerRef = useRef<InstanceType<typeof pdfjs.TextLayer> | null>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [textVersion, setTextVersion] = useState(0);
  const [rendered, setRendered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useEffect(() => {
    let alive = true;
    setError(null);
    pdf
      .getPage(index + 1)
      .then((p) => alive && setPage(p))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [pdf, index]);

  // --- canvas ------------------------------------------------------------------
  useEffect(() => {
    if (!page) return;
    let cancelled = false;
    let task: ReturnType<PDFPageProxy["render"]> | null = null;
    // Debounce re-renders while zooming; the stale bitmap is CSS-stretched meanwhile.
    const hasBitmap = !!canvasHolder.current?.firstChild;
    const timer = setTimeout(() => {
      const viewport = page.getViewport({ scale: zoom * CSS_UNITS });
      let ratio = window.devicePixelRatio || 1;
      if (viewport.width * viewport.height * ratio * ratio > MAX_CANVAS_PIXELS) {
        ratio = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      canvas.className = "page-canvas";
      task = page.render({
        canvas,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        annotationMode: pdfjs.AnnotationMode.ENABLE,
      });
      task.promise
        .then(() => {
          if (cancelled || !canvasHolder.current) return;
          canvasHolder.current.replaceChildren(canvas);
          setRendered(true);
        })
        .catch((e: { name?: string; message?: string }) => {
          if (e?.name !== "RenderingCancelledException" && !cancelled) setError(e?.message ?? "Render failed");
        });
    }, hasBitmap ? 140 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
    };
  }, [page, zoom]);

  // --- text layer (built once per page; scales via CSS variables) ----------------
  useEffect(() => {
    const container = textRef.current;
    if (!page || !container) return;
    container.replaceChildren();
    textDivs.current = [];
    const tl = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(TEXT_CONTENT_OPTIONS),
      container,
      viewport: page.getViewport({ scale: zoomRef.current * CSS_UNITS }),
    });
    textLayerRef.current = tl;
    tl.render()
      .then(() => {
        textDivs.current = tl.textDivs;
        const end = document.createElement("div");
        end.className = "endOfContent";
        container.append(end);
        setTextVersion((v) => v + 1);
      })
      .catch(() => {});
    return () => {
      tl.cancel();
      textLayerRef.current = null;
    };
  }, [page]);

  useEffect(() => {
    if (page && textLayerRef.current) textLayerRef.current.update({ viewport: page.getViewport({ scale: zoom * CSS_UNITS }) });
  }, [zoom, page]);

  // --- search highlights ------------------------------------------------------------
  const hits = useSearch((s) => s.hits);
  const active = useSearch((s) => s.active);
  const matchCase = useSearch((s) => s.matchCase);
  const focusToken = useSearch((s) => s.focusToken);
  const pageHits = useMemo(() => {
    const out: { start: number; end: number; global: number }[] = [];
    hits.forEach((h, k) => h.page === index && out.push({ start: h.start, end: h.end, global: k }));
    return out;
  }, [hits, index]);
  const [highlights, setHighlights] = useState<HighlightRect[]>([]);

  useEffect(() => {
    let alive = true;
    const pageDiv = pageDivRef.current;
    if (!pageHits.length || !pageDiv || !textDivs.current.length) {
      setHighlights([]);
      return;
    }
    getPageText(pdf, index, matchCase).then((pt) => {
      if (!alive) return;
      const box = pageDiv.getBoundingClientRect();
      const rects: HighlightRect[] = [];
      const range = document.createRange();
      let activeRect: HighlightRect | null = null;
      for (const h of pageHits) {
        for (const seg of rangeToSegments(pt, h)) {
          const node = textDivs.current[seg.item]?.firstChild;
          if (!node || node.nodeType !== Node.TEXT_NODE) continue;
          const len = node.textContent?.length ?? 0;
          range.setStart(node, Math.min(seg.from, len));
          range.setEnd(node, Math.min(seg.to, len));
          for (const r of Array.from(range.getClientRects())) {
            const rect = {
              x: (r.left - box.left) / box.width,
              y: (r.top - box.top) / box.height,
              w: r.width / box.width,
              h: r.height / box.height,
              active: h.global === active,
            };
            rects.push(rect);
            if (rect.active && !activeRect) activeRect = rect;
          }
        }
      }
      setHighlights(rects);
      if (activeRect) viewer.revealPoint(index, activeRect.x + activeRect.w / 2, activeRect.y + activeRect.h / 2);
    });
    return () => {
      alive = false;
    };
    // focusToken: re-reveal when the user steps to a match on this page again
  }, [pageHits, active, textVersion, pdf, index, matchCase, focusToken]);

  return (
    <div
      ref={pageDivRef}
      className="page"
      data-page={index + 1}
      style={
        {
          top,
          left,
          width,
          height,
          "--total-scale-factor": zoom * CSS_UNITS,
          "--scale-factor": zoom * CSS_UNITS,
        } as React.CSSProperties
      }
    >
      <div ref={canvasHolder} className="canvas-holder" />
      {!rendered && !error && <div className="page-loading" />}
      {error && <div className="page-error">Page {index + 1} could not be displayed: {error}</div>}
      <div ref={textRef} className="textLayer" />
      {highlights.length > 0 && (
        <div className="search-layer">
          {highlights.map((r, k) => (
            <div
              key={k}
              className={`search-hit${r.active ? " active" : ""}`}
              style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
            />
          ))}
        </div>
      )}
      {page && <PageOverlays page={page} pageIndex={index} pageId={pageId} zoom={zoom} textDivs={textDivs} textVersion={textVersion} />}
    </div>
  );
});
