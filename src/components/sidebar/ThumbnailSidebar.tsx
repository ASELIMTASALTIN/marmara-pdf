import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  FilePlus2,
  FileOutput,
  FileStack,
  RotateCcw,
  RotateCw,
  Trash2,
  Scissors,
} from "lucide-react";
import { useDoc } from "../../state/documentStore";
import { useUi } from "../../state/uiStore";
import { CSS_UNITS, type PDFDocumentProxy } from "../../core/pdf/pdfjs";
import {
  deletePagesAction,
  duplicate,
  extract,
  insertBlank,
  insertFromFilePicker,
  movePages,
  rotate,
  splitDialog,
} from "../../actions/pageActions";
import { viewer } from "../viewer/viewerController";
import { showContextMenu, type MenuItem } from "../common/ContextMenu";

const THUMB_W = 136;
const LABEL_H = 22;
const ITEM_PAD = 14;

/** Rendered thumbnails, cached per pdf.js proxy. */
const thumbCache = new WeakMap<PDFDocumentProxy, Map<number, string>>();

async function renderThumb(pdf: PDFDocumentProxy, index: number): Promise<string> {
  let cache = thumbCache.get(pdf);
  if (!cache) thumbCache.set(pdf, (cache = new Map()));
  const hit = cache.get(index);
  if (hit) return hit;
  const page = await pdf.getPage(index + 1);
  const base = page.getViewport({ scale: CSS_UNITS });
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const viewport = page.getViewport({ scale: (CSS_UNITS * THUMB_W * ratio) / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  const url = canvas.toDataURL("image/jpeg", 0.85);
  cache.set(index, url);
  return url;
}

const Thumb = memo(function Thumb({
  pdf,
  index,
  height,
  selected,
  current,
  dragging,
}: {
  pdf: PDFDocumentProxy;
  index: number;
  height: number;
  selected: boolean;
  current: boolean;
  dragging: boolean;
}) {
  const [src, setSrc] = useState<string | null>(() => thumbCache.get(pdf)?.get(index) ?? null);
  useEffect(() => {
    let alive = true;
    const cached = thumbCache.get(pdf)?.get(index);
    if (cached) {
      setSrc(cached);
      return;
    }
    const t = setTimeout(() => {
      renderThumb(pdf, index).then((u) => alive && setSrc(u)).catch(() => {});
    }, 30);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [pdf, index]);

  return (
    <div className={`thumb${selected ? " selected" : ""}${current ? " current" : ""}${dragging ? " dragging" : ""}`} data-index={index}>
      <div className="thumb-frame" style={{ height }}>
        {src ? <img src={src} alt={`Page ${index + 1}`} draggable={false} /> : <div className="thumb-placeholder" />}
        <div className="thumb-actions" onPointerDown={(e) => e.stopPropagation()}>
          <button title="Rotate left" onClick={() => rotate(-90, [index])}>
            <RotateCcw size={13} />
          </button>
          <button title="Rotate right" onClick={() => rotate(90, [index])}>
            <RotateCw size={13} />
          </button>
          <button title="Delete page" onClick={() => deletePagesAction([index])}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <div className="thumb-label">{index + 1}</div>
    </div>
  );
});

export function ThumbnailSidebar() {
  const pdf = useDoc((s) => s.pdf);
  const sizes = useDoc((s) => s.pageSizes);
  const selected = useUi((s) => s.selectedPages);
  const current = useUi((s) => s.currentPage);
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const [drag, setDrag] = useState<{ indices: number[]; target: number } | null>(null);

  const layout = useMemo(() => {
    const tops: number[] = [];
    const heights: number[] = [];
    let y = 8;
    for (const s of sizes) {
      const h = Math.round(Math.min(THUMB_W * 1.6, (THUMB_W * s.h) / s.w));
      tops.push(y);
      heights.push(h);
      y += h + LABEL_H + ITEM_PAD;
    }
    return { tops, heights, total: y + 8 };
  }, [sizes]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the current page's thumbnail in view.
  useEffect(() => {
    const el = ref.current;
    if (!el || drag || current >= layout.tops.length) return;
    const top = layout.tops[current];
    const bottom = top + layout.heights[current] + LABEL_H;
    if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) el.scrollTop = top - el.clientHeight / 3;
  }, [current, layout, drag]);

  const indexAtY = useCallback(
    (y: number) => {
      // Drop target: before the first item whose midpoint is below y.
      for (let i = 0; i < layout.tops.length; i++) if (y < layout.tops[i] + layout.heights[i] / 2) return i;
      return layout.tops.length;
    },
    [layout],
  );

  const select = (index: number, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    const { selectedPages, selectionAnchor } = useUi.getState();
    if (e.shiftKey && selectionAnchor !== null) {
      const [a, b] = [Math.min(selectionAnchor, index), Math.max(selectionAnchor, index)];
      useUi.setState({ selectedPages: Array.from({ length: b - a + 1 }, (_, k) => a + k) });
    } else if (e.ctrlKey || e.metaKey) {
      const set = new Set(selectedPages);
      if (set.has(index)) set.delete(index);
      else set.add(index);
      useUi.setState({ selectedPages: [...set].sort((x, y) => x - y), selectionAnchor: index });
    } else {
      useUi.setState({ selectedPages: [index], selectionAnchor: index });
      viewer.scrollToPage(index);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const item = (e.target as HTMLElement).closest<HTMLElement>(".thumb");
    if (!item || !ref.current) return;
    const index = Number(item.dataset.index);
    const el = ref.current;
    const startY = e.clientY;
    const mods = { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey };
    let dragging = false;
    let autoScroll = 0;
    let lastY = e.clientY;
    const dragSet = selectedSet.has(index) ? [...selected] : [index];

    const update = () => {
      const rect = el.getBoundingClientRect();
      setDrag({ indices: dragSet, target: indexAtY(lastY - rect.top + el.scrollTop) });
    };
    const tick = () => {
      if (!dragging) return;
      const rect = el.getBoundingClientRect();
      const edge = 40;
      const dy = lastY < rect.top + edge ? -12 : lastY > rect.bottom - edge ? 12 : 0;
      if (dy) {
        el.scrollTop += dy;
        update();
      }
      autoScroll = requestAnimationFrame(tick);
    };
    const move = (ev: PointerEvent) => {
      lastY = ev.clientY;
      if (!dragging && Math.abs(ev.clientY - startY) > 6) {
        dragging = true;
        autoScroll = requestAnimationFrame(tick);
      }
      if (dragging) update();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      cancelAnimationFrame(autoScroll);
      if (dragging) {
        const rect = el.getBoundingClientRect();
        const target = indexAtY(lastY - rect.top + el.scrollTop);
        setDrag(null);
        void movePages(dragSet, target);
      } else {
        select(index, mods);
      }
      dragging = false;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".thumb");
    const n = sizes.length;
    let indices: number[];
    let at: number;
    if (item) {
      const index = Number(item.dataset.index);
      if (!selectedSet.has(index)) useUi.setState({ selectedPages: [index], selectionAnchor: index });
      indices = selectedSet.has(index) ? [...selected] : [index];
      at = Math.max(...indices) + 1;
    } else {
      indices = [];
      at = n;
    }
    const many = indices.length > 1 ? ` ${indices.length} pages` : "";
    const items: MenuItem[] = indices.length
      ? [
          { label: `Rotate right${many}`, icon: RotateCw, shortcut: "Ctrl+R", onSelect: () => rotate(90, indices) },
          { label: `Rotate left${many}`, icon: RotateCcw, shortcut: "Ctrl+Shift+R", onSelect: () => rotate(-90, indices) },
          { label: `Duplicate${many}`, icon: Copy, onSelect: () => duplicate(indices) },
          { label: `Extract${many} to new PDF…`, icon: FileOutput, onSelect: () => extract(indices) },
          { kind: "separator" },
          { label: "Insert blank page before", icon: FilePlus2, onSelect: () => insertBlank(Math.min(...indices)) },
          { label: "Insert blank page after", icon: FilePlus2, onSelect: () => insertBlank(at) },
          { label: "Insert pages from file after…", icon: FileStack, onSelect: () => insertFromFilePicker(at) },
          { kind: "separator" },
          { label: `Delete${many}`, icon: Trash2, shortcut: "Del", danger: true, disabled: indices.length >= n, onSelect: () => deletePagesAction(indices) },
        ]
      : [
          { label: "Insert blank page at end", icon: FilePlus2, onSelect: () => insertBlank(n) },
          { label: "Insert pages from file at end…", icon: FileStack, onSelect: () => insertFromFilePicker(n) },
          { label: "Split document…", icon: Scissors, onSelect: () => splitDialog() },
        ];
    showContextMenu(e, items);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = sizes.length;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      void deletePagesAction();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      useUi.setState({ selectedPages: Array.from({ length: n }, (_, i) => i), selectionAnchor: 0 });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, Math.min(n - 1, current + (e.key === "ArrowDown" ? 1 : -1)));
      select(next, { ctrlKey: false, metaKey: false, shiftKey: e.shiftKey });
      if (e.shiftKey) viewer.scrollToPage(next);
    } else if (e.key === "Escape") {
      useUi.setState({ selectedPages: [], selectionAnchor: null });
    }
  };

  if (!pdf) return null;

  const visTop = scroll.top - 400;
  const visBottom = scroll.top + scroll.height + 400;
  const items = [];
  for (let i = 0; i < layout.tops.length; i++) {
    const top = layout.tops[i];
    if (top + layout.heights[i] + LABEL_H < visTop) continue;
    if (top > visBottom) break;
    items.push(
      <div key={i} className="thumb-slot" style={{ top, height: layout.heights[i] + LABEL_H }}>
        <Thumb
          pdf={pdf}
          index={i}
          height={layout.heights[i]}
          selected={selectedSet.has(i)}
          current={i === current}
          dragging={!!drag && drag.indices.includes(i)}
        />
      </div>,
    );
  }
  const indicatorTop =
    drag && (drag.target < layout.tops.length ? layout.tops[drag.target] - ITEM_PAD / 2 : layout.total - ITEM_PAD);

  return (
    <div
      ref={ref}
      className="thumb-list"
      tabIndex={0}
      onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      aria-label="Page thumbnails"
      data-testid="thumbnails"
    >
      <div className="thumb-inner" style={{ height: layout.total }}>
        {items}
        {drag && <div className="drop-indicator" style={{ top: indicatorTop as number }} />}
      </div>
    </div>
  );
}
