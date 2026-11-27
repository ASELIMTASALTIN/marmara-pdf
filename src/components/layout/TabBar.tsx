import { FileText, Plus, X } from "lucide-react";
import { useDoc } from "../../state/documentStore";
import { switchTo, tabs, useSessions } from "../../state/sessions";
import { closeDocument, openWithPicker } from "../../actions/fileActions";

/** Document tabs (visible when more than one document is open). */
export function TabBar() {
  // Re-render on tab changes and on the active document's name/dirty state.
  useSessions((s) => s.order.join("|") + Object.keys(s.parked).join("|"));
  const activeId = useDoc((s) => s.doc?.id);
  useDoc((s) => `${s.doc?.name}|${s.dirty}`);
  const list = tabs();
  if (list.length < 2) return null;
  return (
    <div className="tabbar" role="tablist" aria-label="Open documents">
      {list.map((t) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === activeId}
          className={`doc-tab${t.id === activeId ? " active" : ""}`}
          title={t.name}
          onClick={() => switchTo(t.id)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              switchTo(t.id);
              void closeDocument();
            }
          }}
        >
          <FileText size={13} />
          <span className="doc-tab-name">{t.name}</span>
          {t.dirty && <span className="dirty-dot" />}
          <button
            className="doc-tab-close"
            title="Close"
            onClick={(e) => {
              e.stopPropagation();
              switchTo(t.id);
              void closeDocument();
            }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button className="doc-tab-new" title="Open another document (Ctrl+O)" onClick={() => openWithPicker()}>
        <Plus size={14} />
      </button>
    </div>
  );
}
