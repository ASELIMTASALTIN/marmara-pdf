import { useMemo } from "react";
import {
  Circle,
  Highlighter,
  ImageIcon,
  Minus,
  MoveUpRight,
  PenLine,
  Signature,
  Square,
  StickyNote,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  type LucideIcon,
} from "lucide-react";
import { useDoc } from "../../state/documentStore";
import { setTool, useUi } from "../../state/uiStore";
import type { Annotation } from "../../core/annotations/types";
import { annotationBounds } from "../../core/annotations/types";
import { annotationLabel, deleteAnnotation, updateAnnotation } from "../../actions/annotationActions";
import { viewer } from "../viewer/viewerController";

const ICONS: Record<Annotation["type"], LucideIcon> = {
  highlight: Highlighter,
  underline: Underline,
  strikeout: Strikethrough,
  ink: PenLine,
  rect: Square,
  ellipse: Circle,
  line: Minus,
  arrow: MoveUpRight,
  freetext: Type,
  note: StickyNote,
  signature: Signature,
  image: ImageIcon,
};

function describe(a: Annotation): string {
  if ("text" in a && a.text) return a.text;
  return "";
}

export function AnnotationList() {
  const annotations = useDoc((s) => s.annotations);
  const pageIds = useDoc((s) => s.doc?.pageIds ?? []);
  const sizes = useDoc((s) => s.pageSizes);
  const selected = useUi((s) => s.selectedAnnotation);

  const groups = useMemo(
    () =>
      pageIds
        .map((id, index) => ({ id, index, list: annotations[id] ?? [] }))
        .filter((g) => g.list.length > 0),
    [annotations, pageIds],
  );

  if (!groups.length)
    return (
      <div className="empty-panel muted">
        No comments or markup yet.
        <br />
        Use the annotation tools in the toolbar to add some.
      </div>
    );

  const reveal = (pageId: string, index: number, a: Annotation) => {
    setTool("select");
    useUi.setState({ selectedAnnotation: { pageId, id: a.id } });
    const b = annotationBounds(a);
    const size = sizes[index];
    // Approximate position (unrotated) to bring the annotation into view.
    const fy = size ? 1 - ((b[1] + b[3]) / 2) / (size.h / (96 / 72)) : 0.5;
    viewer.scrollToPage(index, { offsetFraction: Math.max(0, Math.min(1, fy - 0.3)) });
  };

  return (
    <div className="annotation-list">
      {groups.map((g) => (
        <section key={g.id}>
          <h3>Page {g.index + 1}</h3>
          {g.list.map((a) => {
            const Icon = ICONS[a.type];
            const isSel = selected?.id === a.id;
            const desc = describe(a);
            return (
              <div key={a.id} className={`annotation-item${isSel ? " selected" : ""}`} onClick={() => reveal(g.id, g.index, a)}>
                <div className="annotation-head">
                  <span className="annotation-icon" style={{ color: a.type === "signature" || a.type === "image" ? undefined : a.color }}>
                    <Icon size={15} />
                  </span>
                  <span className="annotation-type">{annotationLabel(a.type)}</span>
                  <span className="annotation-time">{new Date(a.createdAt).toLocaleDateString()}</span>
                  <button
                    className="row-action"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteAnnotation(g.id, a.id);
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {desc && <div className="annotation-text">{desc}</div>}
                {isSel && a.type !== "note" && a.type !== "freetext" && (
                  <textarea
                    className="annotation-comment"
                    placeholder="Add a comment…"
                    defaultValue={a.comment ?? ""}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      if ((a.comment ?? "") !== e.target.value) void updateAnnotation(g.id, a.id, { comment: e.target.value }, "Edit comment");
                    }}
                  />
                )}
                {!isSel && a.comment && <div className="annotation-comment-view">{a.comment}</div>}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
