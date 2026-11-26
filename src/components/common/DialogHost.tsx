import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import { useDialogs, type DialogField } from "../../state/dialogStore";
import { useDoc } from "../../state/documentStore";

function initialValues(fields: DialogField[] = []): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.key, f.value !== undefined ? String(f.value) : ""]));
}

function Dialog({ dialog }: { dialog: ReturnType<typeof useDialogs.getState>["dialogs"][number] }) {
  const [values, setValues] = useState(() => initialValues(dialog.fields));
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const close = (button: string) => {
    const err = dialog.validate?.(values, button) ?? null;
    if (err) {
      setError(err);
      return;
    }
    dialog.resolve({ button, values });
  };

  useEffect(() => {
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("input, select, textarea") ?? el?.querySelector<HTMLElement>(".btn.primary, .btn.danger");
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
  }, []);

  const primary = dialog.buttons.find((b) => b.variant === "primary") ?? dialog.buttons[dialog.buttons.length - 1];

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close("cancel")}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
        style={dialog.width ? { width: dialog.width } : undefined}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close("cancel");
          } else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault();
            close(primary.id);
          }
        }}
      >
        <h2 className="modal-title">{dialog.title}</h2>
        {dialog.message && <div className="modal-message">{dialog.message}</div>}
        {dialog.fields?.map((f) => (
          <label key={f.key} className={`field field-${f.kind}`}>
            <span className="field-label">{f.label}</span>
            {f.kind === "text" && (
              <input
                type={f.password ? "password" : "text"}
                value={values[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            )}
            {f.kind === "number" && (
              <input
                type="number"
                min={f.min}
                max={f.max}
                value={values[f.key]}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              />
            )}
            {f.kind === "select" && (
              <select value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            {f.kind === "radio" && (
              <div className="radio-group" role="radiogroup">
                {f.options.map((o) => (
                  <label key={o.value} className={`radio${values[f.key] === o.value ? " checked" : ""}`}>
                    <input
                      type="radio"
                      name={f.key}
                      checked={values[f.key] === o.value}
                      onChange={() => setValues({ ...values, [f.key]: o.value })}
                    />
                    <span>
                      {o.label}
                      {o.hint && <small>{o.hint}</small>}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {f.kind === "text" && f.hint && <small className="field-hint">{f.hint}</small>}
          </label>
        ))}
        {dialog.body?.({ values, close })}
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-buttons">
          {dialog.buttons.map((b) => (
            <button key={b.id} className={`btn ${b.variant ?? ""}`} onClick={() => close(b.id)}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DialogHost() {
  const dialogs = useDialogs((s) => s.dialogs);
  return (
    <>
      {dialogs.map((d) => (
        <Dialog key={d.id} dialog={d} />
      ))}
    </>
  );
}

export function Toasts() {
  const toasts = useDialogs((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === "success" ? <CheckCircle2 size={16} /> : t.kind === "error" ? <XCircle size={16} /> : <Info size={16} />}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

export function BusyOverlay() {
  const busy = useDoc((s) => s.busy);
  const [visible, setVisible] = useState(false);
  // Only show for operations that take noticeable time.
  useEffect(() => {
    if (!busy) {
      setVisible(false);
      return;
    }
    const t = setTimeout(() => setVisible(true), 250);
    return () => clearTimeout(t);
  }, [busy]);
  if (!busy || !visible) return null;
  return (
    <div className="busy-overlay" role="status">
      <div className="busy-card">
        <Loader2 size={20} className="spin" />
        <span>{busy}</span>
      </div>
    </div>
  );
}
