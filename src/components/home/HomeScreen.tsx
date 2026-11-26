import { useEffect, useState } from "react";
import { Clock, Combine, FileText, FolderOpen, History, Images, ShieldCheck, Trash2, X } from "lucide-react";
import {
  discardRecovery,
  getRecentFiles,
  openPath,
  openWithPicker,
  pickAndMerge,
  removeRecent,
  restoreRecovery,
  type RecentFile,
} from "../../actions/fileActions";
import { platform, type RecoveryEntry } from "../../platform";

function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

const fmtSize = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

export function HomeScreen() {
  const [recent, setRecent] = useState<RecentFile[]>(getRecentFiles);
  const [recovery, setRecovery] = useState<RecoveryEntry[]>([]);

  useEffect(() => {
    const refresh = () => setRecent(getRecentFiles());
    window.addEventListener("marmara:recent", refresh);
    return () => window.removeEventListener("marmara:recent", refresh);
  }, []);

  const loadRecovery = () => platform.recovery.list().then(setRecovery).catch(() => setRecovery([]));
  useEffect(() => {
    void loadRecovery();
  }, []);

  return (
    <div className="home" data-testid="home">
      <div className="home-inner">
        <section className="home-hero">
          <h1>Open a PDF to get started</h1>
          <p>Read, annotate, organise pages, edit text and run OCR — everything stays on this computer.</p>
          <div className="home-actions">
            <button className="btn primary lg" onClick={openWithPicker}>
              <FolderOpen size={18} /> Open PDF…
            </button>
            <button className="btn lg" onClick={pickAndMerge}>
              <Combine size={18} /> Combine files…
            </button>
            <button className="btn lg" onClick={() => import("../../actions/convertActions").then((m) => m.createPdfFromImages())}>
              <Images size={18} /> PDF from images…
            </button>
          </div>
          <div className="drop-hint">or drop PDF files anywhere in this window</div>
        </section>

        {recovery.length > 0 && (
          <section className="home-section recovery">
            <h2>
              <History size={16} /> Recovered documents
            </h2>
            <p className="muted">These documents had unsaved changes when Marmara PDF last closed.</p>
            <ul className="file-list">
              {recovery.map((r) => (
                <li key={r.id}>
                  <button className="file-row" onClick={() => restoreRecovery(r.id, r.name, r.originalPath)}>
                    <FileText size={18} className="file-icon" />
                    <span className="file-name">{r.name}</span>
                    <span className="file-meta">
                      {fmtSize(r.size)} · {timeAgo(r.savedAt)}
                    </span>
                  </button>
                  <button
                    className="row-action"
                    title="Discard"
                    onClick={async () => {
                      await discardRecovery(r.id);
                      void loadRecovery();
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {platform.isDesktop && (
          <section className="home-section">
            <h2>
              <Clock size={16} /> Recent files
            </h2>
            {recent.length === 0 ? (
              <p className="muted">Files you open will appear here.</p>
            ) : (
              <ul className="file-list">
                {recent.map((r) => (
                  <li key={r.path}>
                    <button className="file-row" onClick={() => openPath(r.path)} title={r.path}>
                      <FileText size={18} className="file-icon" />
                      <span className="file-name">{r.name}</span>
                      <span className="file-path">{r.path.replace(/[\\/][^\\/]*$/, "")}</span>
                      <span className="file-meta">{timeAgo(r.openedAt)}</span>
                    </button>
                    <button className="row-action" title="Remove from list" onClick={() => removeRecent(r.path)}>
                      <X size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <footer className="home-footer">
          <ShieldCheck size={14} /> Private by design: documents are processed locally and never uploaded.
        </footer>
      </div>
    </div>
  );
}
