import { useEffect, useState } from "react";
import { Download, KeyRound, Plus, Trash2, Upload } from "lucide-react";
import { confirm, openDialog } from "../../state/dialogStore";
import {
  createDigitalIdDialog,
  deleteDigitalId,
  exportDigitalId,
  importDigitalIdDialog,
  listDigitalIds,
} from "../../actions/signatureActions";

function IdList() {
  const [ids, setIds] = useState(listDigitalIds);
  useEffect(() => {
    const refresh = () => setIds(listDigitalIds());
    window.addEventListener("marmara:ids", refresh);
    return () => window.removeEventListener("marmara:ids", refresh);
  }, []);
  return (
    <div className="id-list">
      {ids.length === 0 && <p className="muted">No digital IDs yet.</p>}
      {ids.map((id) => (
        <div key={id.id} className="id-row">
          <KeyRound size={18} className="id-icon" />
          <div className="id-text">
            <div className="id-name">
              {id.name}
              {id.email && <span className="muted"> &lt;{id.email}&gt;</span>}
            </div>
            <div className="muted small">
              {id.selfSigned ? "Self-signed" : `Issued by ${id.issuer}`} · valid until {new Date(id.notAfter).toLocaleDateString()} · SHA-256{" "}
              {id.fingerprint.slice(0, 16).replace(/(..)/g, "$1:").slice(0, -1)}…
            </div>
          </div>
          <button className="row-action" title="Export (.pfx)" onClick={() => exportDigitalId(id)}>
            <Download size={15} />
          </button>
          <button
            className="row-action"
            title="Remove"
            onClick={async () => {
              if (await confirm("Remove digital ID?", `The digital ID of ${id.name} will be removed from this computer. Export it first if you want to keep it.`, { danger: true, confirmLabel: "Remove" }))
                deleteDigitalId(id);
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <div className="id-buttons">
        <button className="btn sm" onClick={() => createDigitalIdDialog()}>
          <Plus size={14} /> Create…
        </button>
        <button className="btn sm" onClick={() => importDigitalIdDialog()}>
          <Upload size={14} /> Import .pfx / .p12…
        </button>
      </div>
    </div>
  );
}

export async function digitalIdsDialog() {
  await openDialog({
    title: "Digital IDs",
    message: "Certificates used to sign documents. Private keys are stored on this computer, protected by your password.",
    body: () => <IdList />,
    buttons: [{ id: "ok", label: "Close", variant: "primary" }],
    width: 600,
  });
}
