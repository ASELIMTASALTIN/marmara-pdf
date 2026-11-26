import {
  Combine,
  FolderOpen,
  Maximize,
  Redo2,
  Save,
  SaveAll,
  Search,
  Undo2,
  X,
  FileOutput,
  FilePlus2,
  FileStack,
  RotateCw,
  RotateCcw,
  Scissors,
  Trash2,
  ChevronDown,
  LayoutGrid,
  FileType2,
  FileImage,
  FileText,
  Images,
  Share,
  FileSignature,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import { useDoc } from "../../state/documentStore";
import { useSearch } from "../../state/searchStore";
import { runCommand } from "../../actions/commands";
import { IconButton } from "../common/IconButton";
import { showContextMenu } from "../common/ContextMenu";

function Logo() {
  return (
    <div className="logo" aria-label="Marmara PDF">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
        <rect x="4" y="2" width="22" height="28" rx="4" fill="var(--accent)" />
        <path d="M9 19c3-3 6 3 9 0s4-3 5-2" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" />
        <path d="M9 24c3-3 6 3 9 0s4-3 5-2" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" opacity=".6" />
        <rect x="9" y="8" width="10" height="2.4" rx="1.2" fill="#fff" />
      </svg>
      <span>Marmara PDF</span>
    </div>
  );
}

function openPagesMenu(e: React.MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showContextMenu({ clientX: r.left, clientY: r.bottom + 4 }, [
    { label: "Rotate right", icon: RotateCw, shortcut: "Ctrl+R", onSelect: () => runCommand("page.rotateRight") },
    { label: "Rotate left", icon: RotateCcw, shortcut: "Ctrl+Shift+R", onSelect: () => runCommand("page.rotateLeft") },
    { kind: "separator" },
    { label: "Insert blank page", icon: FilePlus2, onSelect: () => runCommand("page.insertBlank") },
    { label: "Insert pages from file…", icon: FileStack, onSelect: () => runCommand("page.insertFile") },
    { label: "Extract pages…", icon: FileOutput, onSelect: () => runCommand("page.extract") },
    { label: "Split document…", icon: Scissors, onSelect: () => runCommand("page.split") },
    { kind: "separator" },
    { label: "Delete pages", icon: Trash2, danger: true, onSelect: () => runCommand("page.delete") },
  ]);
}

function openExportMenu(e: React.MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showContextMenu({ clientX: r.left, clientY: r.bottom + 4 }, [
    { label: "Word document (.docx)…", icon: FileType2, onSelect: () => runCommand("export.word") },
    { label: "Images (PNG / JPEG)…", icon: FileImage, onSelect: () => runCommand("export.images") },
    { label: "Plain text (.txt)…", icon: FileText, onSelect: () => runCommand("export.text") },
    { kind: "separator" },
    { label: "Create PDF from images…", icon: Images, onSelect: () => runCommand("file.fromImages") },
  ]);
}

function openSignMenu(e: React.MouseEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showContextMenu({ clientX: r.left, clientY: r.bottom + 4 }, [
    { label: "Sign digitally…", icon: FileSignature, onSelect: () => runCommand("sign.document") },
    { label: "Signature panel", icon: ShieldCheck, onSelect: () => runCommand("sign.panel") },
    { kind: "separator" },
    { label: "Manage digital IDs…", icon: KeyRound, onSelect: () => runCommand("sign.ids") },
  ]);
}

export function TopBar() {
  const doc = useDoc((s) => s.doc);
  const dirty = useDoc((s) => s.dirty);
  const canUndo = useDoc((s) => s.undoStack.length > 0);
  const canRedo = useDoc((s) => s.redoStack.length > 0);
  const searchOpen = useSearch((s) => s.open);

  return (
    <header className="topbar">
      <Logo />
      <div className="topbar-group">
        <IconButton icon={FolderOpen} label="Open" command="file.open" showLabel onClick={() => runCommand("file.open")} />
        <IconButton icon={Save} label="Save" command="file.save" disabled={!doc} onClick={() => runCommand("file.save")} />
        <IconButton icon={SaveAll} label="Save as" command="file.saveAs" disabled={!doc} onClick={() => runCommand("file.saveAs")} />
        <IconButton icon={Combine} label="Combine files" command="file.combine" onClick={() => runCommand("file.combine")} />
        {doc && (
          <button type="button" className="menu-btn" onClick={openExportMenu} title="Export / convert">
            <Share size={16} strokeWidth={1.75} />
            <span>Export</span>
            <ChevronDown size={14} />
          </button>
        )}
        {doc && (
          <button type="button" className="menu-btn" onClick={openSignMenu} title="Digital signatures">
            <FileSignature size={16} strokeWidth={1.75} />
            <span>Sign</span>
            <ChevronDown size={14} />
          </button>
        )}
        {doc && (
          <button type="button" className="menu-btn" onClick={openPagesMenu} title="Page tools">
            <LayoutGrid size={16} strokeWidth={1.75} />
            <span>Pages</span>
            <ChevronDown size={14} />
          </button>
        )}
      </div>

      <div className="doc-title" title={doc?.path ?? doc?.name}>
        {doc && (
          <>
            <span className="doc-name">{doc.name}</span>
            {dirty && <span className="dirty-dot" title="Unsaved changes" />}
            <button type="button" className="close-doc" title="Close document (Ctrl+W)" onClick={() => runCommand("file.close")}>
              <X size={14} />
            </button>
          </>
        )}
      </div>

      <div className="topbar-group right">
        <IconButton icon={Undo2} label="Undo" command="edit.undo" disabled={!canUndo} onClick={() => runCommand("edit.undo")} />
        <IconButton icon={Redo2} label="Redo" command="edit.redo" disabled={!canRedo} onClick={() => runCommand("edit.redo")} />
        <span className="divider" />
        <IconButton
          icon={Search}
          label="Find"
          command="search.open"
          disabled={!doc}
          active={searchOpen}
          onClick={() => (searchOpen ? useSearch.setState({ open: false }) : runCommand("search.open"))}
        />
        <IconButton icon={Maximize} label="Full-screen reading" command="view.fullscreen" disabled={!doc} onClick={() => runCommand("view.fullscreen")} />
      </div>
    </header>
  );
}
