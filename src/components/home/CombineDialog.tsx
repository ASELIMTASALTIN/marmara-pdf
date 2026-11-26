import { useState } from "react";
import { ArrowDown, ArrowUp, FileText, Plus, X } from "lucide-react";
import { openDialog } from "../../state/dialogStore";
import { platform, type OpenedFile } from "../../platform";

function CombineList({ initial, onChange }: { initial: OpenedFile[]; onChange: (f: OpenedFile[]) => void }) {
  const [files, setFiles] = useState(initial);
  const update = (next: OpenedFile[]) => {
    setFiles(next);
    onChange(next);
  };
  const move = (i: number, d: number) => {
    const next = [...files];
    const [f] = next.splice(i, 1);
    next.splice(i + d, 0, f);
    update(next);
  };
  return (
    <div className="combine-list">
      <ol>
        {files.map((f, i) => (
          <li key={`${f.name}-${i}`}>
            <FileText size={16} />
            <span className="file-name">{f.name}</span>
            <span className="file-meta">{(f.bytes.length / 1e6).toFixed(1)} MB</span>
            <button className="row-action" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={14} />
            </button>
            <button className="row-action" title="Move down" disabled={i === files.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown size={14} />
            </button>
            <button className="row-action" title="Remove" onClick={() => update(files.filter((_, k) => k !== i))}>
              <X size={14} />
            </button>
          </li>
        ))}
      </ol>
      <button
        className="btn sm"
        onClick={async () => update([...files, ...(await platform.pickPdfs({ multiple: true, title: "Add PDFs" }))])}
      >
        <Plus size={14} /> Add files…
      </button>
    </div>
  );
}

/** Lets the user order the files to combine. Resolves to the ordered list or null. */
export async function CombineDialog(files: OpenedFile[]): Promise<OpenedFile[] | null> {
  let current = files;
  const r = await openDialog({
    title: "Combine files",
    message: "Files are combined in this order into a new document.",
    body: () => <CombineList initial={files} onChange={(f) => (current = f)} />,
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Combine", variant: "primary" },
    ],
    validate: (_v, b) => (b === "ok" && current.length < 2 ? "Choose at least two files" : null),
    width: 520,
  });
  return r.button === "ok" ? current : null;
}
