import { Trash2 } from "lucide-react";
import { useDoc } from "../../state/documentStore";
import { useUi, type Tool } from "../../state/uiStore";
import { annotationLabel, deleteAnnotation, updateAnnotation } from "../../actions/annotationActions";
import type { Annotation } from "../../core/annotations/types";

const COLORS = ["#ffd400", "#ff8c00", "#d1242f", "#e83e8c", "#8250df", "#1f6feb", "#1a7f37", "#1f2328"];

const HINTS: Partial<Record<Tool, string>> = {
  highlight: "Select text to highlight it",
  underline: "Select text to underline it",
  strikeout: "Select text to strike it through",
  ink: "Drag to draw freehand",
  rect: "Drag to draw a rectangle · Shift for square",
  ellipse: "Drag to draw an ellipse · Shift for circle",
  line: "Drag to draw a line · Shift snaps to 45°",
  arrow: "Drag to draw an arrow · Shift snaps to 45°",
  freetext: "Click where the text box should go",
  note: "Click to place a sticky note",
  signature: "Click on the page to place your signature",
  image: "Click on the page to place the image",
  eraser: "Click or drag over annotations to remove them",
  "edit-text": "Click a line of text to edit it",
};

const WIDTH_TYPES = new Set(["ink", "rect", "ellipse", "line", "arrow"]);
const COLOR_TYPES = new Set(["highlight", "underline", "strikeout", "ink", "rect", "ellipse", "line", "arrow", "freetext", "note"]);

export function StyleBar() {
  const tool = useUi((s) => s.tool);
  const toolStyles = useUi((s) => s.toolStyles);
  const sel = useUi((s) => s.selectedAnnotation);
  const selected: Annotation | undefined = useDoc((s) => (sel ? s.annotations[sel.pageId]?.find((a) => a.id === sel.id) : undefined));

  const kind: string | null = selected ? selected.type : toolStyles[tool] ? tool : null;
  const hint = HINTS[tool];
  if (!kind && !hint) return null;

  const st = kind ? (selected ? { ...toolStyles[kind], ...pick(selected) } : toolStyles[kind]) : null;

  const apply = (patch: Partial<{ color: string; width: number; opacity: number; fontSize: number; fill: string | null }>) => {
    if (kind && toolStyles[kind]) useUi.setState({ toolStyles: { ...toolStyles, [kind]: { ...toolStyles[kind], ...stripFill(patch) } } });
    if (selected && sel) void updateAnnotation(sel.pageId, selected.id, patch as Partial<Annotation>, `Change ${annotationLabel(selected.type)} style`);
  };

  return (
    <div className="stylebar" role="toolbar" aria-label="Annotation style">
      {selected && <span className="stylebar-title">{capitalize(annotationLabel(selected.type))}</span>}
      {st && kind && COLOR_TYPES.has(kind) && (
        <div className="swatches" role="radiogroup" aria-label="Color">
          {COLORS.map((c) => (
            <button
              key={c}
              className={`swatch${st.color?.toLowerCase() === c ? " active" : ""}`}
              style={{ background: c }}
              title={c}
              aria-label={`Color ${c}`}
              onClick={() => apply({ color: c })}
            />
          ))}
          <label className="swatch custom" title="Custom color">
            <input type="color" value={st.color} onChange={(e) => apply({ color: e.target.value })} />
          </label>
        </div>
      )}
      {st && kind && WIDTH_TYPES.has(kind) && (
        <label>
          Width
          <input type="range" min={0.5} max={12} step={0.5} value={st.width} onChange={(e) => apply({ width: +e.target.value })} />
          <span className="value">{st.width}pt</span>
        </label>
      )}
      {st && kind && kind !== "note" && (
        <label>
          Opacity
          <input type="range" min={0.1} max={1} step={0.05} value={st.opacity} onChange={(e) => apply({ opacity: +e.target.value })} />
          <span className="value">{Math.round(st.opacity * 100)}%</span>
        </label>
      )}
      {st && kind === "freetext" && (
        <label>
          Size
          <select value={st.fontSize} onChange={(e) => apply({ fontSize: +e.target.value })}>
            {[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && (selected.type === "rect" || selected.type === "ellipse") && (
        <label>
          <input type="checkbox" checked={!!selected.fill} onChange={(e) => apply({ fill: e.target.checked ? selected.color : null })} />
          Fill
        </label>
      )}
      {selected && sel && (
        <button className="btn sm" onClick={() => deleteAnnotation(sel.pageId, selected.id)}>
          <Trash2 size={13} /> Delete
        </button>
      )}
      {!selected && hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function pick(a: Annotation) {
  return {
    color: a.color,
    opacity: a.opacity,
    ...("width" in a ? { width: a.width } : {}),
    ...("fontSize" in a ? { fontSize: a.fontSize } : {}),
  };
}
function stripFill<T extends { fill?: unknown }>(p: T): Omit<T, "fill"> {
  const { fill: _f, ...rest } = p;
  return rest;
}
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
