import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDoc } from "../../state/documentStore";
import { clampZoom, setZoom, useUi } from "../../state/uiStore";
import { PageView } from "./PageView";
import { viewer, zoomAnchor } from "./viewerController";
import { useTextMarkup } from "../../hooks/useTextMarkup";

const GAP = 16; // vertical gap between pages (px)
const PAD = 24; // horizontal padding around pages (px)
const OVERSCAN = 1.0; // render pages within ±1 viewport height

interface Layout {
  tops: number[];
  widths: number[];
  heights: number[];
  total: number;
  maxW: number;
  zoom: number;
}

function computeLayout(sizes: { w: number; h: number }[], zoom: number): Layout {
  const tops: number[] = new Array(sizes.length);
  const widths: number[] = new Array(sizes.length);
  const heights: number[] = new Array(sizes.length);
  let y = GAP;
  let maxW = 0;
  for (let i = 0; i < sizes.length; i++) {
    const w = Math.floor(sizes[i].w * zoom);
    const h = Math.floor(sizes[i].h * zoom);
    tops[i] = y;
    widths[i] = w;
    heights[i] = h;
    y += h + GAP;
    if (w > maxW) maxW = w;
  }
  return { tops, widths, heights, total: y, maxW, zoom };
}

/** Index of the last page whose top is <= y. */
function pageAt(layout: Layout, y: number): number {
  let lo = 0;
  let hi = layout.tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

export function Viewer() {
  const pdf = useDoc((s) => s.pdf);
  const sizes = useDoc((s) => s.pageSizes);
  const pageIds = useDoc((s) => s.doc?.pageIds ?? []);
  const zoom = useUi((s) => s.zoom);
  const zoomMode = useUi((s) => s.zoomMode);
  const tool = useUi((s) => s.tool);
  const fullscreen = useUi((s) => s.fullscreen);

  useTextMarkup();
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, left: 0, width: 800, height: 600 });
  const layout = useMemo(() => computeLayout(sizes, zoom), [sizes, zoom]);
  const layoutRef = useRef(layout);
  const prevLayoutRef = useRef<Layout | null>(null);

  // --- fit modes ---------------------------------------------------------------
  const applyFit = useCallback(() => {
    const el = ref.current;
    const { zoomMode: mode, currentPage } = useUi.getState();
    if (!el || !sizes.length || mode === "custom") return;
    const availW = el.clientWidth - PAD * 2;
    const availH = el.clientHeight - GAP * 2;
    const ref0 = sizes[Math.min(currentPage, sizes.length - 1)];
    const maxBaseW = Math.max(...sizes.slice(0, 200).map((s) => s.w), ref0.w);
    const fitW = availW / maxBaseW;
    const z = mode === "fit-width" ? fitW : Math.min(availW / ref0.w, availH / ref0.h);
    const next = clampZoom(Math.floor(z * 1000) / 1000);
    if (Math.abs(next - useUi.getState().zoom) > 0.002) setZoom(next, mode);
  }, [sizes]);

  useLayoutEffect(applyFit, [applyFit, zoomMode, fullscreen]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setView((v) => ({ ...v, width: el.clientWidth, height: el.clientHeight }));
      applyFit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [applyFit]);

  // --- keep the point under the anchor stable when zoom changes ------------------
  useLayoutEffect(() => {
    const el = ref.current;
    const prev = prevLayoutRef.current;
    prevLayoutRef.current = layout;
    layoutRef.current = layout;
    if (!el || !prev || prev.zoom === layout.zoom || prev.tops.length !== layout.tops.length || !layout.tops.length) return;
    const anchor = zoomAnchor.current ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    zoomAnchor.current = null;
    const docY = el.scrollTop + anchor.y;
    const i = pageAt(prev, docY);
    const fy = (docY - prev.tops[i]) / Math.max(1, prev.heights[i]);
    const innerPrevW = Math.max(el.clientWidth, prev.maxW + PAD * 2);
    const leftPrev = (innerPrevW - prev.widths[i]) / 2;
    const fx = (el.scrollLeft + anchor.x - leftPrev) / Math.max(1, prev.widths[i]);
    const innerW = Math.max(el.clientWidth, layout.maxW + PAD * 2);
    const left = (innerW - layout.widths[i]) / 2;
    el.scrollTop = layout.tops[i] + fy * layout.heights[i] - anchor.y;
    el.scrollLeft = left + fx * layout.widths[i] - anchor.x;
    setView((v) => ({ ...v, top: el.scrollTop, left: el.scrollLeft }));
  }, [layout]);

  // --- scroll tracking -------------------------------------------------------------
  const raf = useRef(0);
  const onScroll = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      setView({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight });
      const l = layoutRef.current;
      if (!l.tops.length) return;
      // Current page = page under a line 35% down the viewport (or the last page at the bottom).
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      const cur = atBottom ? l.tops.length - 1 : pageAt(l, el.scrollTop + el.clientHeight * 0.35);
      if (cur !== useUi.getState().currentPage) useUi.setState({ currentPage: cur });
    });
  }, []);

  // Reset scroll when a different document is loaded.
  const docId = useDoc((s) => s.doc?.id);
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [docId]);

  // --- imperative api -----------------------------------------------------------
  useEffect(() => {
    viewer.register({
      element: () => ref.current,
      scrollToPage(i, opts) {
        const el = ref.current;
        const l = layoutRef.current;
        if (!el || !l.tops.length) return;
        const idx = Math.max(0, Math.min(l.tops.length - 1, i));
        const top = l.tops[idx] - GAP / 2 + (opts?.offsetFraction ?? 0) * l.heights[idx];
        el.scrollTo({ top, behavior: opts?.smooth ? "smooth" : "auto" });
        useUi.setState({ currentPage: idx });
      },
      revealPage(i) {
        const el = ref.current;
        const l = layoutRef.current;
        if (!el || i < 0 || i >= l.tops.length) return;
        const visTop = Math.max(el.scrollTop, l.tops[i]);
        const visBot = Math.min(el.scrollTop + el.clientHeight, l.tops[i] + l.heights[i]);
        const visible = (visBot - visTop) / Math.min(l.heights[i], el.clientHeight);
        if (visible < 0.6) this.scrollToPage(i);
      },
      revealPoint(i, fx, fy) {
        const el = ref.current;
        const l = layoutRef.current;
        if (!el || i < 0 || i >= l.tops.length) return;
        const y = l.tops[i] + fy * l.heights[i];
        const innerW = Math.max(el.clientWidth, l.maxW + PAD * 2);
        const x = (innerW - l.widths[i]) / 2 + fx * l.widths[i];
        const margin = 80;
        if (y < el.scrollTop + margin || y > el.scrollTop + el.clientHeight - margin) el.scrollTop = y - el.clientHeight / 2;
        if (x < el.scrollLeft + margin || x > el.scrollLeft + el.clientWidth - margin) el.scrollLeft = x - el.clientWidth / 2;
      },
      scrollBy(dy) {
        ref.current?.scrollBy({ top: dy });
      },
    });
    return () => viewer.register(null);
  }, []);

  // --- ctrl+wheel zoom (anchored at the cursor) -----------------------------------
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAnchor.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
      setZoom(useUi.getState().zoom * factor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // --- hand tool panning -------------------------------------------------------------
  const pan = useRef<{ x: number; y: number; top: number; left: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    // Clicking empty space clears the annotation selection.
    const t = e.target as HTMLElement;
    if (useUi.getState().selectedAnnotation && !t.closest("[data-ann-id], .sel-handle, .note-popup")) {
      useUi.setState({ selectedAnnotation: null, editingAnnotation: null });
    }
    const isMiddle = e.button === 1;
    if (!(tool === "hand" && e.button === 0) && !isMiddle) return;
    const el = ref.current!;
    pan.current = { x: e.clientX, y: e.clientY, top: el.scrollTop, left: el.scrollLeft };
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pan.current;
    if (!p) return;
    const el = ref.current!;
    el.scrollTop = p.top - (e.clientY - p.y);
    el.scrollLeft = p.left - (e.clientX - p.x);
  };
  const endPan = () => (pan.current = null);

  // --- visible range -----------------------------------------------------------------
  const n = layout.tops.length;
  let first = 0;
  let last = -1;
  if (n) {
    const over = view.height * OVERSCAN;
    first = pageAt(layout, Math.max(0, view.top - over));
    last = pageAt(layout, view.top + view.height + over);
  }
  const innerW = Math.max(view.width, layout.maxW + PAD * 2);

  const pages = [];
  for (let i = first; i <= last && pdf; i++) {
    pages.push(
      <PageView
        key={pageIds[i] ?? i}
        pdf={pdf}
        index={i}
        pageId={pageIds[i]}
        zoom={zoom}
        width={layout.widths[i]}
        height={layout.heights[i]}
        top={layout.tops[i]}
        left={Math.floor((innerW - layout.widths[i]) / 2)}
      />,
    );
  }

  return (
    <div
      ref={ref}
      className={`viewer tool-${tool}`}
      tabIndex={0}
      onScroll={onScroll}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      data-testid="viewer"
      style={{ overflowX: layout.maxW + PAD * 2 > view.width + 1 ? "auto" : "hidden" }}
    >
      <div className="viewer-inner" style={{ height: layout.total, width: innerW }}>
        {pages}
      </div>
    </div>
  );
}
