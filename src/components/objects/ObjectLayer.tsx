import { useEffect, useRef, useState } from "react";
import { ImageUp, Trash2 } from "lucide-react";
import type { PageViewport } from "../../core/pdf/pdfjs";
import type { PageObject, ObjectEdit } from "../../core/objects/objects";
import type { Rect } from "../../core/annotations/types";
import { rectToView, viewRectToPdf } from "../../core/annotations/geometry";
import { commit, exclusive, useDoc, withBusy } from "../../state/documentStore";
import { errorMessage, toast } from "../../state/dialogStore";
import { pickImageFile } from "../annotations/SignatureDialog";

const cache = new WeakMap<Uint8Array, Map<number, Promise<PageObject[]>>>();
function load(bytes: Uint8Array, page: number) {
  let m = cache.get(bytes);
  if (!m) cache.set(bytes, (m = new Map()));
  let p = m.get(page);
  if (!p) {
    p = import("../../core/objects/objects").then((x) => x.listPageObjects(bytes, page));
    m.set(page, p);
  }
  return p;
}

async function applyEdit(pageIndex: number, id: string, edit: ObjectEdit, label: string) {
  await exclusive(async () => {
    const { doc } = useDoc.getState();
    if (!doc) return;
    try {
      const { editPageObject } = await import("../../core/objects/objects");
      const bytes = await withBusy("Editing…", () => editPageObject(doc.bytes, pageIndex, id, edit));
      await commit(label, { bytes });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  });
}

type Drag = { mode: "move" | "resize"; sx: number; sy: number; x: number; y: number; ox?: number; oy?: number };

/** "Edit objects" mode: select, move, resize, recolour, replace or delete page images and graphics. */
export function ObjectLayer({ viewport: vp, pageIndex }: { viewport: PageViewport; pageIndex: number }) {
  const bytes = useDoc((s) => s.doc?.bytes);
  const [objects, setObjects] = useState<PageObject[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!bytes) return;
    let alive = true;
    load(bytes, pageIndex)
      .then((o) => alive && setObjects(o))
      .catch(() => alive && setObjects([]));
    return () => {
      alive = false;
    };
  }, [bytes, pageIndex]);

  const pageArea = vp.width * vp.height;
  const boxes = (objects ?? [])
    .map((o) => ({ o, b: rectToView(vp, o.bbox) }))
    // hide invisible hairlines and full-page backgrounds
    .filter(({ b }) => b.w * b.h > 9 && b.w * b.h < pageArea * 0.92);
  const sel = boxes.find((x) => x.o.id === selected);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const preview = (b: { x: number; y: number; w: number; h: number }) => {
    if (!drag) return b;
    if (drag.mode === "move") return { ...b, x: b.x + drag.x - drag.sx, y: b.y + drag.y - drag.sy };
    const x0 = Math.min(drag.ox!, drag.x);
    const y0 = Math.min(drag.oy!, drag.y);
    return { x: x0, y: y0, w: Math.abs(drag.x - drag.ox!), h: Math.abs(drag.y - drag.oy!) };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const [x, y] = local(e);
    const handle = (e.target as HTMLElement).dataset.handle;
    if (handle && sel) {
      const ox = handle.includes("w") ? sel.b.x + sel.b.w : sel.b.x;
      const oy = handle.includes("n") ? sel.b.y + sel.b.h : sel.b.y;
      setDrag({ mode: "resize", sx: x, sy: y, x, y, ox, oy });
      ref.current!.setPointerCapture(e.pointerId);
      return;
    }
    // smallest object under the pointer
    const hits = boxes.filter(({ b }) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h).sort((a, c) => a.b.w * a.b.h - c.b.w * c.b.h);
    if (!hits.length) {
      setSelected(null);
      return;
    }
    setSelected(hits[0].o.id);
    setDrag({ mode: "move", sx: x, sy: y, x, y });
    ref.current!.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const [x, y] = local(e);
    setDrag({ ...drag, x, y });
  };
  const onPointerUp = () => {
    const d = drag;
    setDrag(null);
    if (!d || !sel) return;
    if (Math.hypot(d.x - d.sx, d.y - d.sy) < 2) return;
    const nb = preview(sel.b);
    if (nb.w < 2 || nb.h < 2) return;
    const to: Rect = viewRectToPdf(vp, nb.x, nb.y, nb.x + nb.w, nb.y + nb.h);
    void applyEdit(pageIndex, sel.o.id, { action: "transform", to }, d.mode === "move" ? "Move object" : "Resize object");
    setSelected(null);
  };

  return (
    <div ref={ref} className="object-layer" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      {boxes.map(({ o, b }) => {
        const isSel = o.id === selected;
        const v = isSel ? preview(b) : b;
        return (
          <div
            key={o.id}
            className={`obj-box ${o.kind}${isSel ? " selected" : ""}`}
            style={{ left: v.x, top: v.y, width: v.w, height: v.h }}
            title={o.kind === "image" ? "Image" : `Graphic (${[o.fill && "fill", o.stroke && "stroke"].filter(Boolean).join(" + ")})`}
          >
            {isSel && !drag && (
              <>
                {["nw", "ne", "sw", "se"].map((h) => (
                  <div key={h} data-handle={h} className={`sel-handle h-${h}`} style={{ left: h.includes("w") ? 0 : "100%", top: h.includes("n") ? 0 : "100%" }} />
                ))}
                <div className="obj-toolbar" onPointerDown={(e) => e.stopPropagation()}>
                  {o.kind === "image" && (
                    <button
                      title="Replace image"
                      onClick={async () => {
                        const img = await pickImageFile();
                        if (img) {
                          const bin = atob(img.dataUrl.slice(img.dataUrl.indexOf(",") + 1));
                          void applyEdit(pageIndex, o.id, { action: "replace-image", image: Uint8Array.from(bin, (c) => c.charCodeAt(0)) }, "Replace image");
                        }
                      }}
                    >
                      <ImageUp size={14} />
                    </button>
                  )}
                  {o.kind === "path" && o.fill && (
                    <label title="Fill colour" className="obj-color">
                      <span>Fill</span>
                      <input type="color" defaultValue="#d1242f" onChange={(e) => void applyEdit(pageIndex, o.id, { action: "recolor", fill: e.target.value }, "Change fill colour")} />
                    </label>
                  )}
                  {o.kind === "path" && o.stroke && (
                    <label title="Line colour" className="obj-color">
                      <span>Line</span>
                      <input type="color" defaultValue="#1f2328" onChange={(e) => void applyEdit(pageIndex, o.id, { action: "recolor", stroke: e.target.value }, "Change line colour")} />
                    </label>
                  )}
                  <button title="Delete" onClick={() => void applyEdit(pageIndex, o.id, { action: "delete" }, o.kind === "image" ? "Delete image" : "Delete graphic")}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
      {objects === null && <div className="te-status">Finding objects…</div>}
    </div>
  );
}
