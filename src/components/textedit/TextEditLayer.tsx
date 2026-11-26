import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, GripVertical, Trash2, X } from "lucide-react";
import type { PDFPageProxy, PageViewport } from "../../core/pdf/pdfjs";
import type { TextBlockInfo } from "../../core/textedit/editor";
import { rectToView, toPdf } from "../../core/annotations/geometry";
import { useDoc } from "../../state/documentStore";
import { cancelEdit, commitEdit, deleteActiveBlock, startEdit, updateEdit, useTextEdit, type ActiveTextEdit } from "../../actions/textEditActions";

export interface TextEditLayerProps {
  page: PDFPageProxy;
  viewport: PageViewport;
  pageId: string;
  pageIndex: number;
}

const CSS_FAMILY = {
  sans: "Helvetica, Arial, 'Segoe UI', sans-serif",
  serif: "'Times New Roman', Times, serif",
  mono: "'Courier New', Courier, monospace",
} as const;

// Block lists cached per document bytes + page (cleared implicitly when bytes change).
const blockCache = new WeakMap<Uint8Array, Map<number, Promise<TextBlockInfo[]>>>();
function loadBlocks(bytes: Uint8Array, page: number): Promise<TextBlockInfo[]> {
  let m = blockCache.get(bytes);
  if (!m) blockCache.set(bytes, (m = new Map()));
  let p = m.get(page);
  if (!p) {
    p = import("../../core/textedit/editor").then((e) => e.analyzePageText(bytes, page));
    m.set(page, p);
  }
  return p;
}

function unit(a: [number, number], b: [number, number]): [number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

function Editor({ a, vp }: { a: ActiveTextEdit; vp: PageViewport }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(40);
  const s = vp.scale;
  const fam = a.family === "original" ? a.block?.family ?? "sans" : a.family;
  const fontPx = a.size * s;

  // Position (view px) of the text box top-left.
  let left: number;
  let top: number;
  let maskBox: { x: number; y: number; w: number; h: number } | null = null;
  if (a.block) {
    const b = rectToView(vp, a.block.bbox);
    maskBox = b;
    const o = vp.convertToViewportPoint(a.block.origin[0] + a.dx, a.block.origin[1] + a.dy);
    left = o[0];
    top = o[1] - fontPx * 0.82;
  } else {
    const o = vp.convertToViewportPoint(a.origin![0] + a.dx, a.origin![1] + a.dy);
    left = o[0];
    top = o[1] - fontPx * 0.82;
  }

  useLayoutEffect(() => {
    if (measureRef.current) setWidth(Math.max(fontPx * 2, measureRef.current.offsetWidth + fontPx));
  }, [a.text, fontPx, fam]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (a.block) el.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag to move.
  const onGrip = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, dx: a.dx, dy: a.dy };
    const p0 = toPdf(vp, 0, 0);
    const move = (ev: PointerEvent) => {
      const p1 = toPdf(vp, ev.clientX - start.x, ev.clientY - start.y);
      updateEdit({ dx: start.dx + (p1[0] - p0[0]), dy: start.dy + (p1[1] - p0[1]) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      inputRef.current?.focus();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const lines = a.text.split("\n").length;
  const style: React.CSSProperties = {
    fontFamily: CSS_FAMILY[fam],
    fontWeight: a.block?.bold ? 700 : 400,
    fontStyle: a.block?.italic ? "italic" : "normal",
    fontSize: fontPx,
    lineHeight: 1.25,
    color: a.color,
  };

  return (
    <>
      {maskBox && !a.block?.invisible && (
        <div className="te-mask" style={{ left: maskBox.x - 1, top: maskBox.y - 1, width: maskBox.w + 2, height: maskBox.h + 2 }} />
      )}
      <div className="te-editor" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
        <div className="te-toolbar" style={{ bottom: "100%" }}>
          <button className="te-grip" title="Drag to move" onPointerDown={onGrip}>
            <GripVertical size={14} />
          </button>
          <select value={a.family} onChange={(e) => updateEdit({ family: e.target.value as ActiveTextEdit["family"] })} title="Font">
            {a.block && <option value="original">Original ({a.block.fontName})</option>}
            <option value="sans">Sans (Helvetica)</option>
            <option value="serif">Serif (Times)</option>
            <option value="mono">Mono (Courier)</option>
          </select>
          <input
            type="number"
            className="te-size"
            min={4}
            max={200}
            step={0.5}
            value={+a.size.toFixed(1)}
            title="Font size (pt)"
            onChange={(e) => +e.target.value > 0 && updateEdit({ size: +e.target.value })}
          />
          <input type="color" value={a.color} title="Text colour" onChange={(e) => updateEdit({ color: e.target.value })} />
          {a.block && (
            <button title="Delete this text" onClick={() => void deleteActiveBlock()}>
              <Trash2 size={14} />
            </button>
          )}
          <button title="Cancel (Esc)" onClick={cancelEdit}>
            <X size={14} />
          </button>
          <button className="te-apply" title="Apply (Enter)" onClick={() => void commitEdit()}>
            <Check size={14} />
          </button>
        </div>
        <span ref={measureRef} className="te-measure" style={style}>
          {a.text.split("\n").reduce((l, x) => (x.length > l.length ? x : l), "") || " "}
        </span>
        <textarea
          ref={inputRef}
          className="te-input"
          value={a.text}
          rows={lines}
          spellCheck={false}
          style={{ ...style, width, height: fontPx * 1.25 * lines + 4 }}
          onChange={(e) => updateEdit({ text: a.block ? e.target.value.replace(/\n/g, " ") : e.target.value })}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            } else if (e.key === "Enter" && (!e.shiftKey || a.block)) {
              e.preventDefault();
              void commitEdit();
            }
          }}
        />
        {!a.block && <div className="te-hint">Enter to add · Shift+Enter for a new line · Esc to cancel</div>}
      </div>
    </>
  );
}

/** Edit-text mode overlay: shows editable text lines and hosts the inline editor. */
export function TextEditLayer({ viewport: vp, pageIndex }: TextEditLayerProps) {
  const bytes = useDoc((s) => s.doc?.bytes);
  const active = useTextEdit((s) => s.active);
  const [blocks, setBlocks] = useState<TextBlockInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bytes) return;
    let alive = true;
    setBlocks(null);
    loadBlocks(bytes, pageIndex)
      .then((b) => alive && setBlocks(b))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [bytes, pageIndex]);

  const here = active?.pageIndex === pageIndex ? active : null;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Clicking elsewhere while editing applies the current edit first.
    if (active) {
      void commitEdit();
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-block]")?.dataset.block;
    const block = id ? blocks?.find((b) => b.id === id) : undefined;
    if (block) {
      if (!block.editable) return;
      startEdit({ pageIndex, block, text: block.text, size: block.size, color: block.color, family: "original", dx: 0, dy: 0 });
      return;
    }
    // New text at the click position (baseline slightly below the pointer).
    const size = 12;
    const base = toPdf(vp, x, y + size * vp.scale * 0.35);
    startEdit({
      pageIndex,
      block: null,
      origin: base,
      dir: unit(toPdf(vp, x, y), toPdf(vp, x + 10, y)),
      up: unit(toPdf(vp, x, y), toPdf(vp, x, y - 10)),
      text: "",
      size,
      color: "#000000",
      family: "sans",
      dx: 0,
      dy: 0,
    });
  };

  return (
    <div className="textedit-layer" onPointerDown={onPointerDown}>
      {blocks?.map((b) => {
        if (here?.block?.id === b.id) return null;
        const box = rectToView(vp, b.bbox);
        return (
          <div
            key={b.id}
            data-block={b.id}
            className={`te-block${b.editable ? "" : " locked"}${b.invisible ? " invisible" : ""}`}
            style={{ left: box.x - 2, top: box.y - 1, width: box.w + 4, height: box.h + 2 }}
            title={
              b.editable
                ? `${b.fontName} · ${b.size.toFixed(1)} pt${b.invisible ? " · recognised (OCR) text" : ""}`
                : `This text uses a font that cannot be decoded (${b.fontName})`
            }
          />
        );
      })}
      {!blocks && !error && <div className="te-status">Analysing text…</div>}
      {error && <div className="te-status error">Text analysis failed: {error}</div>}
      {here && <Editor a={here} vp={vp} />}
    </div>
  );
}
