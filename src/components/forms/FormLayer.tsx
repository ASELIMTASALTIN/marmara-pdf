import { memo, useEffect, useState } from "react";
import type { PDFPageProxy, PageViewport } from "../../core/pdf/pdfjs";
import { normRect, rectToView } from "../../core/annotations/geometry";
import type { Rect } from "../../core/annotations/types";
import { commit, exclusive, useDoc } from "../../state/documentStore";
import { useUi } from "../../state/uiStore";
import { X } from "lucide-react";

/** Subset of pdf.js widget annotation data used for form filling. */
interface WidgetData {
  id: string;
  subtype: string;
  fieldType?: "Tx" | "Btn" | "Ch" | "Sig";
  fieldName: string;
  fieldValue?: string | string[] | null;
  rect: Rect;
  readOnly?: boolean;
  hidden?: boolean;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  exportValue?: string;
  buttonValue?: string;
  options?: { exportValue: string; displayValue: string }[];
  combo?: boolean;
  multiSelect?: boolean;
  multiLine?: boolean;
  password?: boolean;
  maxLen?: number;
  textAlignment?: number;
  defaultAppearanceData?: { fontSize?: number; fontColor?: Uint8ClampedArray | number[] };
}

function setValue(name: string, value: string | boolean) {
  void exclusive(async () => {
    const { formValues } = useDoc.getState();
    if (formValues[name] === value) return;
    await commit(`Fill “${name}”`, { formValues: { ...formValues, [name]: value } });
  });
}

function TextField({ w, value, style }: { w: WidgetData; value: string; style: React.CSSProperties }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const done = () => draft !== value && setValue(w.fieldName, draft);
  const common = {
    className: "form-input",
    value: draft,
    readOnly: w.readOnly,
    maxLength: w.maxLen || undefined,
    title: w.fieldName,
    style,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: done,
    onKeyDown: (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter" && !w.multiLine) (e.target as HTMLElement).blur();
      if (e.key === "Escape") {
        setDraft(value);
        (e.target as HTMLElement).blur();
      }
    },
  };
  return w.multiLine ? <textarea {...common} /> : <input type={w.password ? "password" : "text"} {...common} />;
}

/** Interactive AcroForm fields drawn over a page. */
export const FormLayer = memo(function FormLayer({ page, viewport: vp }: { page: PDFPageProxy; viewport: PageViewport }) {
  const [widgets, setWidgets] = useState<WidgetData[]>([]);
  const values = useDoc((s) => s.formValues);
  const preparing = useUi((s) => s.tool === "form");

  useEffect(() => {
    let alive = true;
    page
      .getAnnotations({ intent: "display" })
      .then((anns) => {
        if (!alive) return;
        setWidgets(
          (anns as WidgetData[]).filter((a) => a.subtype === "Widget" && !!a.fieldType && !a.hidden),
        );
      })
      .catch(() => alive && setWidgets([]));
    return () => {
      alive = false;
    };
  }, [page]);

  if (!widgets.length) return null;

  if (preparing) {
    return (
      <div className="form-layer preparing">
        {widgets.map((w) => {
          const b = rectToView(vp, normRect(w.rect));
          return (
            <div key={w.id} className="form-prep" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} title={`${w.fieldName} (${w.fieldType})`}>
              <span className="form-prep-name">{w.fieldName}</span>
              <button
                className="form-prep-del"
                title={`Delete field “${w.fieldName}”`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => void import("../../actions/formActions").then((m) => m.removeFieldAction(w.fieldName))}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="form-layer">
      {widgets.map((w) => {
        const b = rectToView(vp, normRect(w.rect));
        const pos: React.CSSProperties = { left: b.x, top: b.y, width: b.w, height: b.h };
        const stored = values[w.fieldName];
        const fs = w.defaultAppearanceData?.fontSize;
        let fontSize = fs && fs > 0 ? fs * vp.scale : Math.max(8, Math.min(b.h * 0.62, 18 * vp.scale));
        if (w.multiLine && fontSize * 2.2 > b.h) fontSize = 11 * vp.scale; // same rule as when saving
        const textStyle: React.CSSProperties = {
          ...pos,
          fontSize,
          textAlign: w.textAlignment === 1 ? "center" : w.textAlignment === 2 ? "right" : "left",
        };

        if (w.fieldType === "Sig" || w.pushButton) return null;
        if (w.fieldType === "Tx") {
          const v = typeof stored === "string" ? stored : typeof w.fieldValue === "string" ? w.fieldValue : "";
          return <TextField key={w.id} w={w} value={v} style={textStyle} />;
        }
        if (w.fieldType === "Btn" && w.checkBox) {
          const on = typeof stored === "boolean" ? stored : !!w.fieldValue && w.fieldValue !== "Off";
          return (
            <label key={w.id} className={`form-check${on ? " on" : ""}${w.readOnly ? " ro" : ""}`} style={pos} title={w.fieldName}>
              <input type="checkbox" checked={on} disabled={w.readOnly} onChange={(e) => setValue(w.fieldName, e.target.checked)} />
              <span style={{ fontSize: b.h * 0.8 }}>✓</span>
            </label>
          );
        }
        if (w.fieldType === "Btn" && w.radioButton) {
          const cur = typeof stored === "string" ? stored : (w.fieldValue as string | undefined);
          const on = !!w.buttonValue && cur === w.buttonValue;
          return (
            <label key={w.id} className={`form-radio${on ? " on" : ""}${w.readOnly ? " ro" : ""}`} style={pos} title={`${w.fieldName}: ${w.buttonValue}`}>
              <input type="radio" name={w.fieldName} checked={on} disabled={w.readOnly} onChange={() => w.buttonValue && setValue(w.fieldName, w.buttonValue)} />
              <span />
            </label>
          );
        }
        if (w.fieldType === "Ch") {
          const cur = typeof stored === "string" ? stored : Array.isArray(w.fieldValue) ? w.fieldValue[0] ?? "" : (w.fieldValue ?? "");
          return (
            <select
              key={w.id}
              className="form-input form-select"
              style={textStyle}
              value={cur}
              disabled={w.readOnly}
              size={w.combo ? undefined : Math.max(2, Math.floor(b.h / (fontSize * 1.3)))}
              title={w.fieldName}
              onChange={(e) => setValue(w.fieldName, e.target.value)}
            >
              {w.combo && !w.options?.some((o) => o.exportValue === cur) && <option value={cur}>{cur}</option>}
              {w.options?.map((o) => (
                <option key={o.exportValue} value={o.exportValue}>
                  {o.displayValue}
                </option>
              ))}
            </select>
          );
        }
        return null;
      })}
    </div>
  );
});
