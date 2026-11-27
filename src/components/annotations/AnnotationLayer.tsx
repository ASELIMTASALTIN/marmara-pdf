import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { StickyNote } from "lucide-react";
import type { Annotation, Point, Rect } from "../../core/annotations/types";
import { annotationBounds } from "../../core/annotations/types";
import {
  rectToView,
  simplifyPath,
  svgPath,
  toPdf,
  toView,
  viewRectToPdf,
  type ViewportLike,
} from "../../core/annotations/geometry";
import { hasEndpoints, isResizable, moveAnnotation } from "../../core/annotations/transform";
import { useDoc } from "../../state/documentStore";
import { DRAW_TOOLS, setTool, useUi, type Tool } from "../../state/uiStore";
import { addAnnotation, deleteAnnotation, updateAnnotation } from "../../actions/annotationActions";
import type { PageViewport } from "../../core/pdf/pdfjs";

const EMPTY: Annotation[] = [];

interface Props {
  viewport: PageViewport;
  pageId: string;
  pageIndex: number;
}

type Draft =
  | { kind: "ink"; points: Point[] }
  | { kind: "box"; tool: Tool; x0: number; y0: number; x1: number; y1: number };

type Drag =
  | { mode: "move"; id: string; sx: number; sy: number; x: number; y: number }
  | { mode: "resize"; id: string; ox: number; oy: number; x: number; y: number }
  | { mode: "endpoint"; id: string; end: "from" | "to"; x: number; y: number };

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function polygon(vp: ViewportLike, r: Rect): string {
  return [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[2], r[3]],
    [r[0], r[3]],
  ]
    .map((p) => toView(vp, p as Point).map((v) => v.toFixed(2)).join(","))
    .join(" ");
}

function arrowHead(from: Point, to: Point, size: number): string {
  const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const a1 = ang + Math.PI - 0.45;
  const a2 = ang + Math.PI + 0.45;
  return `M${to[0] + size * Math.cos(a1)},${to[1] + size * Math.sin(a1)} L${to[0]},${to[1]} L${to[0] + size * Math.cos(a2)},${to[1] + size * Math.sin(a2)}`;
}

/** An HTML box that follows the page rotation (for text and images). */
function RotatedBox({ vp, rect, children, className, style, id }: { vp: ViewportLike; rect: Rect; children: ReactNode; className?: string; style?: React.CSSProperties; id: string }) {
  const box = rectToView(vp, rect);
  const rot = ((vp.rotation % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  return (
    <div className={`annot-box ${className ?? ""}`} data-ann-id={id} style={{ left: box.x, top: box.y, width: box.w, height: box.h, ...style }}>
      <div
        className="annot-box-inner"
        style={{
          width: swap ? box.h : box.w,
          height: swap ? box.w : box.h,
          transform: `translate(-50%, -50%) rotate(${rot}deg)`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function AnnotationShape({ a, vp, editing, onCommitText }: { a: Annotation; vp: ViewportLike; editing: boolean; onCommitText: (text: string, height?: number) => void }) {
  const s = vp.scale;
  const common = { "data-ann-id": a.id, className: "annot-shape" } as const;
  switch (a.type) {
    case "highlight":
      return (
        <g {...common} style={{ mixBlendMode: "multiply" }}>
          {a.rects.map((r, k) => (
            <polygon key={k} points={polygon(vp, r)} fill={a.color} fillOpacity={a.opacity} className="hit-fill" />
          ))}
        </g>
      );
    case "redact":
      return (
        <g {...common}>
          {a.rects.map((r, k) => (
            <polygon key={k} points={polygon(vp, r)} fill="rgba(209,36,47,0.18)" stroke="#d1242f" strokeWidth={1.5} strokeDasharray="5 3" className="hit-fill" />
          ))}
        </g>
      );
    case "underline":
    case "strikeout":
      return (
        <g {...common}>
          {a.rects.map((r, k) => {
            const h = r[3] - r[1];
            const y = a.type === "underline" ? r[1] + h * 0.06 : r[1] + h * 0.45;
            const p0 = toView(vp, [r[0], y]);
            const p1 = toView(vp, [r[2], y]);
            return (
              <g key={k}>
                <line x1={p0[0]} y1={p0[1]} x2={p1[0]} y2={p1[1]} stroke={a.color} strokeOpacity={a.opacity} strokeWidth={Math.max(1, h * 0.07 * s)} />
                <polygon points={polygon(vp, r)} fill="transparent" className="hit-fill" />
              </g>
            );
          })}
        </g>
      );
    case "ink": {
      const w = Math.max(0.75, a.width * s);
      return (
        <g {...common}>
          {a.paths.map((path, k) => {
            const d = svgPath(path.map((p) => toView(vp, p)));
            return (
              <g key={k}>
                <path d={d} stroke={a.color} strokeOpacity={a.opacity} strokeWidth={w} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                <path d={d} stroke="transparent" strokeWidth={Math.max(10, w + 6)} fill="none" className="hit-stroke" />
              </g>
            );
          })}
        </g>
      );
    }
    case "rect":
      return (
        <g {...common}>
          <polygon
            points={polygon(vp, a.rect)}
            stroke={a.color}
            strokeOpacity={a.opacity}
            strokeWidth={Math.max(0.75, a.width * s)}
            fill={a.fill ?? "transparent"}
            fillOpacity={a.fill ? a.opacity : 0}
            className={a.fill ? "hit-fill" : "hit-stroke"}
          />
          {!a.fill && <polygon points={polygon(vp, a.rect)} stroke="transparent" strokeWidth={10} fill="none" className="hit-stroke" />}
        </g>
      );
    case "ellipse": {
      const b = rectToView(vp, a.rect);
      return (
        <g {...common}>
          <ellipse
            cx={b.x + b.w / 2}
            cy={b.y + b.h / 2}
            rx={b.w / 2}
            ry={b.h / 2}
            stroke={a.color}
            strokeOpacity={a.opacity}
            strokeWidth={Math.max(0.75, a.width * s)}
            fill={a.fill ?? "transparent"}
            fillOpacity={a.fill ? a.opacity : 0}
          />
          <ellipse cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} stroke="transparent" strokeWidth={10} fill="none" className={a.fill ? "hit-fill" : "hit-stroke"} />
        </g>
      );
    }
    case "line":
    case "arrow": {
      const f = toView(vp, a.from);
      const t = toView(vp, a.to);
      const w = Math.max(0.75, a.width * s);
      return (
        <g {...common}>
          <line x1={f[0]} y1={f[1]} x2={t[0]} y2={t[1]} stroke={a.color} strokeOpacity={a.opacity} strokeWidth={w} strokeLinecap="round" />
          {a.type === "arrow" && (
            <path d={arrowHead(f, t, Math.max(9, w * 4))} stroke={a.color} strokeOpacity={a.opacity} strokeWidth={w} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          )}
          <line x1={f[0]} y1={f[1]} x2={t[0]} y2={t[1]} stroke="transparent" strokeWidth={Math.max(12, w + 8)} className="hit-stroke" />
        </g>
      );
    }
    default:
      void editing;
      void onCommitText;
      return null;
  }
}

function FreeTextBox({ a, vp, editing, onCommit }: { a: Extract<Annotation, { type: "freetext" }>; vp: ViewportLike; editing: boolean; onCommit: (text: string, heightPx?: number) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const committed = useRef(false);
  const fontPx = a.fontSize * vp.scale;
  const commit = (text: string, h?: number) => {
    if (committed.current) return;
    committed.current = true;
    onCommit(text, h);
  };
  useEffect(() => {
    if (!editing) return;
    committed.current = false;
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    // Editing can end without a blur (tool switch, Escape elsewhere): commit anyway.
    return () => {
      if (el) commit(el.value, el.scrollHeight);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  const style: React.CSSProperties = { fontSize: fontPx, color: a.color, opacity: a.opacity, lineHeight: 1.25 };
  return (
    <RotatedBox vp={vp} rect={a.rect} id={a.id} className={`annot-freetext${editing ? " editing" : ""}`}>
      {editing ? (
        <textarea
          ref={ref}
          className="freetext-editor"
          defaultValue={a.text}
          style={style}
          placeholder="Type here"
          onPointerDown={(e) => e.stopPropagation()}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.max(el.scrollHeight, fontPx * 1.4)}px`;
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") e.currentTarget.blur();
          }}
          onBlur={(e) => commit(e.currentTarget.value, e.currentTarget.scrollHeight)}
        />
      ) : (
        <div className="freetext-content" style={style}>
          {a.text}
        </div>
      )}
    </RotatedBox>
  );
}

function NoteIcon({ a, vp, selected, onCommit }: { a: Extract<Annotation, { type: "note" }>; vp: ViewportLike; selected: boolean; onCommit: (t: string) => void }) {
  const box = rectToView(vp, annotationBounds(a));
  const size = 22;
  const textRef = useRef<HTMLTextAreaElement>(null);
  const committed = useRef(false);
  const commit = (t: string) => {
    if (committed.current) return;
    committed.current = true;
    onCommit(t);
  };
  // The popup unmounts when the note is deselected, often before a blur fires.
  useEffect(() => {
    if (!selected) return;
    committed.current = false;
    const el = textRef.current;
    return () => {
      if (el) commit(el.value);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  return (
    <>
      <div className="annot-note" data-ann-id={a.id} style={{ left: box.x, top: box.y, width: size, height: size, color: a.color }} title={a.text || "Note"}>
        <StickyNote size={size} fill={a.color} stroke="#5a4500" strokeWidth={1.3} />
      </div>
      {selected && (
        <div className="note-popup" style={{ left: box.x + size + 6, top: box.y }} onPointerDown={(e) => e.stopPropagation()}>
          <textarea
            ref={textRef}
            autoFocus
            defaultValue={a.text}
            placeholder="Write a note…"
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") e.currentTarget.blur();
            }}
            onBlur={(e) => {
              commit(e.currentTarget.value);
              committed.current = false; // allow further edits while still selected
            }}
          />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

export const AnnotationLayer = memo(function AnnotationLayer({ viewport: vp, pageId, pageIndex }: Props) {
  const annotations = useDoc((s) => s.annotations[pageId]) ?? EMPTY;
  const tool = useUi((s) => s.tool);
  const selected = useUi((s) => s.selectedAnnotation);
  const editing = useUi((s) => s.editingAnnotation);
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const erased = useRef(new Set<string>());

  const drawing = DRAW_TOOLS.includes(tool);
  const interactive = tool === "select" || tool === "eraser";
  const selectedHere = selected?.pageId === pageId ? annotations.find((a) => a.id === selected.id) : undefined;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as [number, number];
  };
  const pdfDelta = (x0: number, y0: number, x1: number, y1: number) => {
    const a = toPdf(vp, x0, y0);
    const b = toPdf(vp, x1, y1);
    return [b[0] - a[0], b[1] - a[1]] as const;
  };

  // --- live model while dragging -------------------------------------------------
  const preview = (a: Annotation): Annotation => {
    if (!drag || drag.id !== a.id) return a;
    if (drag.mode === "move") {
      const [dx, dy] = pdfDelta(drag.sx, drag.sy, drag.x, drag.y);
      return moveAnnotation(a, dx, dy);
    }
    if (drag.mode === "resize" && "rect" in a) {
      return { ...a, rect: viewRectToPdf(vp, drag.ox, drag.oy, drag.x, drag.y) } as Annotation;
    }
    if (drag.mode === "endpoint" && hasEndpoints(a)) {
      return { ...a, [drag.end]: toPdf(vp, drag.x, drag.y) } as Annotation;
    }
    return a;
  };

  // --- pointer handling ----------------------------------------------------------------
  const style = (t: string) => useUi.getState().toolStyles[t] ?? { color: "#d1242f", width: 2, opacity: 1, fontSize: 14 };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const [x, y] = local(e);
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-ann-id], [data-handle]");

    if (tool === "eraser") {
      e.preventDefault();
      erased.current = new Set();
      eraseAt(e.clientX, e.clientY);
      ref.current!.setPointerCapture(e.pointerId);
      setDrag({ mode: "move", id: "__eraser", sx: x, sy: y, x, y });
      return;
    }

    if (tool === "select") {
      if (!target) {
        if (selected) useUi.setState({ selectedAnnotation: null, editingAnnotation: null });
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const handle = target.dataset.handle;
      if (handle && selectedHere) {
        ref.current!.setPointerCapture(e.pointerId);
        if (handle === "from" || handle === "to") setDrag({ mode: "endpoint", id: selectedHere.id, end: handle, x, y });
        else {
          const b = rectToView(vp, (selectedHere as { rect: Rect }).rect);
          const ox = handle.includes("w") ? b.x + b.w : b.x;
          const oy = handle.includes("n") ? b.y + b.h : b.y;
          setDrag({ mode: "resize", id: selectedHere.id, ox, oy, x, y });
        }
        return;
      }
      const id = target.dataset.annId!;
      if (editing === id) return;
      useUi.setState({ selectedAnnotation: { pageId, id }, editingAnnotation: null });
      ref.current!.setPointerCapture(e.pointerId);
      setDrag({ mode: "move", id, sx: x, sy: y, x, y });
      return;
    }

    if (!drawing) return;
    e.preventDefault();
    e.stopPropagation();
    const st = style(tool);
    const pending = useUi.getState().pendingImage;

    if (tool === "freetext") {
      const fontPx = st.fontSize * vp.scale;
      const rect = viewRectToPdf(vp, x, y - fontPx * 0.7, x + Math.max(160, fontPx * 12), y + fontPx * 0.9);
      void addAnnotation(pageId, { type: "freetext", rect, text: "", fontSize: st.fontSize, color: st.color, opacity: st.opacity }, true).then((id) => {
        setTool("select");
        useUi.setState({ selectedAnnotation: { pageId, id }, editingAnnotation: id });
      });
      return;
    }
    if (tool === "note") {
      void addAnnotation(pageId, { type: "note", point: toPdf(vp, x - 11, y - 11), text: "", color: "#ffd02f", opacity: 1 }).then((id) => {
        setTool("select");
        useUi.setState({ selectedAnnotation: { pageId, id } });
      });
      return;
    }
    if ((tool === "signature" || tool === "image") && pending) {
      const maxW = vp.width * (pending.kind === "signature" ? 0.3 : 0.5);
      const scale = Math.min(1, maxW / pending.width) * (pending.kind === "signature" ? 1 : vp.scale);
      const w = Math.min(maxW, pending.width * scale);
      const h = (w * pending.height) / pending.width;
      const rect = viewRectToPdf(vp, x - w / 2, y - h / 2, x + w / 2, y + h / 2);
      void addAnnotation(pageId, { type: pending.kind, rect, dataUrl: pending.dataUrl, color: "#000000", opacity: 1 }).then((id) => {
        setTool("select");
        useUi.setState({ selectedAnnotation: { pageId, id } });
      });
      return;
    }
    ref.current!.setPointerCapture(e.pointerId);
    if (tool === "ink") setDraft({ kind: "ink", points: [[x, y]] });
    else setDraft({ kind: "box", tool, x0: x, y0: y, x1: x, y1: y });
  };

  const eraseAt = (cx: number, cy: number) => {
    for (const el of document.elementsFromPoint(cx, cy)) {
      if (!ref.current?.contains(el)) continue;
      const id = (el as HTMLElement).closest<HTMLElement>("[data-ann-id]")?.dataset.annId;
      if (id && !erased.current.has(id)) {
        erased.current.add(id);
        void deleteAnnotation(pageId, id);
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draft && !drag) return;
    const [x, y] = local(e);
    if (drag) {
      if (drag.id === "__eraser") eraseAt(e.clientX, e.clientY);
      else setDrag({ ...drag, x, y });
      return;
    }
    if (draft?.kind === "ink") {
      const last = draft.points[draft.points.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) >= 1.5) setDraft({ kind: "ink", points: [...draft.points, [x, y]] });
    } else if (draft) {
      let [x1, y1] = [x, y];
      if (e.shiftKey && (draft.tool === "line" || draft.tool === "arrow")) {
        const ang = Math.round(Math.atan2(y - draft.y0, x - draft.x0) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(x - draft.x0, y - draft.y0);
        x1 = draft.x0 + len * Math.cos(ang);
        y1 = draft.y0 + len * Math.sin(ang);
      } else if (e.shiftKey) {
        const side = Math.max(Math.abs(x - draft.x0), Math.abs(y - draft.y0));
        x1 = draft.x0 + Math.sign(x - draft.x0 || 1) * side;
        y1 = draft.y0 + Math.sign(y - draft.y0 || 1) * side;
      }
      setDraft({ ...draft, x1, y1 });
    }
  };

  const onPointerUp = () => {
    if (drag) {
      const d = drag;
      setDrag(null);
      if (d.id === "__eraser") return;
      const a = annotations.find((x) => x.id === d.id);
      if (!a) return;
      const moved = d.mode === "move" ? Math.hypot(d.x - d.sx, d.y - d.sy) > 2 : true;
      if (!moved) {
        if (a.type === "freetext" && useUi.getState().selectedAnnotation?.id === a.id) {
          /* single click on a selected text box: start editing on second click (handled by dblclick) */
        }
        return;
      }
      const next = preview(a);
      void updateAnnotation(pageId, a.id, next, d.mode === "move" ? "Move annotation" : "Resize annotation");
      return;
    }
    if (!draft) return;
    const d = draft;
    setDraft(null);
    const st = style(tool);
    if (d.kind === "ink") {
      if (d.points.length < 2) return;
      const pts = simplifyPath(d.points, 0.6).map(([x, y]) => toPdf(vp, x, y));
      void addAnnotation(pageId, { type: "ink", paths: [pts], color: st.color, width: st.width, opacity: st.opacity });
      return;
    }
    if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 4) return;
    if (d.tool === "form") {
      const rect = viewRectToPdf(vp, d.x0, d.y0, d.x1, d.y1);
      void import("../../actions/formActions").then((m) => m.createFieldFlow(pageIndex, rect));
      return;
    }
    if (d.tool === "redact") {
      void addAnnotation(pageId, { type: "redact", rects: [viewRectToPdf(vp, d.x0, d.y0, d.x1, d.y1)], color: "#d1242f", opacity: 1 });
      return;
    }
    if (d.tool === "digital-signature") {
      void import("../../actions/signatureActions").then((m) => m.signatureBoxDrawn(pageIndex, viewRectToPdf(vp, d.x0, d.y0, d.x1, d.y1)));
      return;
    }
    if (d.tool === "rect" || d.tool === "ellipse") {
      void addAnnotation(pageId, { type: d.tool, rect: viewRectToPdf(vp, d.x0, d.y0, d.x1, d.y1), color: st.color, width: st.width, opacity: st.opacity, fill: null });
    } else if (d.tool === "line" || d.tool === "arrow") {
      void addAnnotation(pageId, { type: d.tool, from: toPdf(vp, d.x0, d.y0), to: toPdf(vp, d.x1, d.y1), color: st.color, width: st.width, opacity: st.opacity });
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-ann-id]")?.dataset.annId;
    const a = id && annotations.find((x) => x.id === id);
    if (a && a.type === "freetext") useUi.setState({ selectedAnnotation: { pageId, id: a.id }, editingAnnotation: a.id });
  };

  const commitText = (a: Annotation, text: string, heightPx?: number) => {
    useUi.setState({ editingAnnotation: null });
    if (!text.trim() && (a.type === "freetext" || a.type === "note")) {
      if (a.type === "freetext") void deleteAnnotation(pageId, a.id);
      else if (!a.text) void deleteAnnotation(pageId, a.id);
      return;
    }
    if (a.type === "freetext") {
      const patch: Partial<Annotation> = { text };
      const rot = ((vp.rotation % 360) + 360) % 360;
      if (heightPx && rot === 0) {
        const b = rectToView(vp, a.rect);
        (patch as { rect: Rect }).rect = viewRectToPdf(vp, b.x, b.y, b.x + b.w, b.y + Math.max(heightPx, b.h));
      }
      void updateAnnotation(pageId, a.id, patch, "Edit text box");
    } else if (a.type === "note") void updateAnnotation(pageId, a.id, { text }, "Edit note");
  };

  // --- render -----------------------------------------------------------------------------
  const shapes: ReactNode[] = [];
  const html: ReactNode[] = [];
  for (const raw of annotations) {
    const a = preview(raw);
    const isEditing = editing === a.id;
    if (a.type === "freetext") html.push(<FreeTextBox key={a.id} a={a} vp={vp} editing={isEditing} onCommit={(t, h) => commitText(raw, t, h)} />);
    else if (a.type === "note") html.push(<NoteIcon key={a.id} a={a} vp={vp} selected={selected?.id === a.id && tool === "select"} onCommit={(t) => commitText(raw, t)} />);
    else if (a.type === "image" || a.type === "signature")
      html.push(
        <RotatedBox key={a.id} vp={vp} rect={a.rect} id={a.id} className="annot-image" style={{ opacity: a.opacity }}>
          <img src={a.dataUrl} alt={a.type} draggable={false} />
        </RotatedBox>,
      );
    else shapes.push(<AnnotationShape key={a.id} a={a} vp={vp} editing={false} onCommitText={() => {}} />);
  }

  let selection: ReactNode = null;
  if (selectedHere && tool === "select" && editing !== selectedHere.id) {
    const a = preview(selectedHere);
    const b = rectToView(vp, annotationBounds(a));
    const pad = 4;
    const handles: ReactNode[] = [];
    if (isResizable(a)) {
      for (const h of ["nw", "ne", "sw", "se"]) {
        handles.push(
          <div
            key={h}
            data-handle={h}
            className={`sel-handle h-${h}`}
            style={{ left: h.includes("w") ? -pad : b.w + pad, top: h.includes("n") ? -pad : b.h + pad }}
          />,
        );
      }
    }
    if (hasEndpoints(a) && (a.type === "line" || a.type === "arrow")) {
      const f = toView(vp, a.from);
      const t = toView(vp, a.to);
      handles.push(<div key="from" data-handle="from" className="sel-handle round" style={{ left: f[0] - b.x, top: f[1] - b.y }} />);
      handles.push(<div key="to" data-handle="to" className="sel-handle round" style={{ left: t[0] - b.x, top: t[1] - b.y }} />);
    }
    selection = (
      <div className="sel-box" style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
        <div className="sel-outline" style={{ inset: -pad }} />
        {handles}
      </div>
    );
  }

  let draftEl: ReactNode = null;
  if (draft) {
    const st = style(tool);
    if (draft.kind === "ink") {
      draftEl = <path d={svgPath(draft.points)} stroke={st.color} strokeOpacity={st.opacity} strokeWidth={Math.max(0.75, st.width * vp.scale)} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
    } else {
      const { x0, y0, x1, y1 } = draft;
      const w = Math.max(0.75, st.width * vp.scale);
      if (draft.tool === "form")
        draftEl = (
          <rect x={Math.min(x0, x1)} y={Math.min(y0, y1)} width={Math.abs(x1 - x0)} height={Math.abs(y1 - y0)} stroke="#1366c4" strokeWidth={1.5} strokeDasharray="4 3" fill="rgba(19,102,196,0.10)" />
        );
      else if (draft.tool === "redact")
        draftEl = (
          <rect x={Math.min(x0, x1)} y={Math.min(y0, y1)} width={Math.abs(x1 - x0)} height={Math.abs(y1 - y0)} stroke="#d1242f" strokeWidth={1.5} strokeDasharray="5 3" fill="rgba(209,36,47,0.18)" />
        );
      else if (draft.tool === "digital-signature")
        draftEl = (
          <rect
            x={Math.min(x0, x1)}
            y={Math.min(y0, y1)}
            width={Math.abs(x1 - x0)}
            height={Math.abs(y1 - y0)}
            stroke="#1366c4"
            strokeWidth={1.5}
            strokeDasharray="6 4"
            fill="rgba(19,102,196,0.08)"
          />
        );
      else if (draft.tool === "rect")
        draftEl = <rect x={Math.min(x0, x1)} y={Math.min(y0, y1)} width={Math.abs(x1 - x0)} height={Math.abs(y1 - y0)} stroke={st.color} strokeWidth={w} fill="none" />;
      else if (draft.tool === "ellipse")
        draftEl = <ellipse cx={(x0 + x1) / 2} cy={(y0 + y1) / 2} rx={Math.abs(x1 - x0) / 2} ry={Math.abs(y1 - y0) / 2} stroke={st.color} strokeWidth={w} fill="none" />;
      else
        draftEl = (
          <g stroke={st.color} strokeWidth={w} fill="none" strokeLinecap="round">
            <line x1={x0} y1={y0} x2={x1} y2={y1} />
            {draft.tool === "arrow" && <path d={arrowHead([x0, y0], [x1, y1], Math.max(9, w * 4))} />}
          </g>
        );
    }
  }

  return (
    <div
      ref={ref}
      className={`annot-layer${drawing ? " drawing" : ""}${interactive ? " interactive" : ""} tool-${tool}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <svg className="annot-svg" width={vp.width} height={vp.height}>
        {shapes}
        {draftEl}
      </svg>
      {html}
      {selection}
    </div>
  );
});
