import { FilePlus2, FileStack, Layers, MessageSquareText, RotateCw, ShieldCheck, Trash2 } from "lucide-react";
import { SignaturePanel } from "../signatures/SignaturePanel";
import { useSignatures } from "../../actions/signatureActions";
import { useUi } from "../../state/uiStore";
import { useDoc } from "../../state/documentStore";
import { countAnnotations } from "../../core/annotations/types";
import { ThumbnailSidebar } from "./ThumbnailSidebar";
import { AnnotationList } from "./AnnotationList";
import { deletePagesAction, insertBlank, insertFromFilePicker, rotate, targetPages } from "../../actions/pageActions";
import { IconButton } from "../common/IconButton";

export function Sidebar() {
  const tab = useUi((s) => s.sidebarTab);
  const selected = useUi((s) => s.selectedPages);
  const annCount = useDoc((s) => countAnnotations(s.annotations));
  const pageCount = useDoc((s) => s.pageSizes.length);
  const sigCount = useSignatures((s) => s.signatures?.length ?? 0);

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <div className="sidebar-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "pages"} className={tab === "pages" ? "active" : ""} onClick={() => useUi.setState({ sidebarTab: "pages" })}>
          <Layers size={15} /> Pages
        </button>
        <button
          role="tab"
          aria-selected={tab === "annotations"}
          aria-label="Comments"
          title="Comments"
          className={tab === "annotations" ? "active" : ""}
          onClick={() => useUi.setState({ sidebarTab: "annotations" })}
        >
          <MessageSquareText size={15} /> {annCount > 0 ? <span className="badge">{annCount}</span> : null}
        </button>
        <button
          role="tab"
          aria-selected={tab === "signatures"}
          title="Signatures"
          aria-label="Signatures"
          className={tab === "signatures" ? "active" : ""}
          onClick={() => useUi.setState({ sidebarTab: "signatures" })}
        >
          <ShieldCheck size={15} /> {sigCount > 0 ? <span className="badge">{sigCount}</span> : null}
        </button>
      </div>
      {tab === "pages" ? (
        <>
          <div className="sidebar-actions">
            <span className="muted small">{selected.length > 1 ? `${selected.length} selected` : `${pageCount} pages`}</span>
            <div className="spacer" />
            <IconButton icon={RotateCw} label="Rotate selected right" size={15} onClick={() => rotate(90)} />
            <IconButton icon={FilePlus2} label="Insert blank page after" size={15} onClick={() => insertBlank(Math.max(...targetPages()) + 1)} />
            <IconButton icon={FileStack} label="Insert pages from file after" size={15} onClick={() => insertFromFilePicker(Math.max(...targetPages()) + 1)} />
            <IconButton icon={Trash2} label="Delete selected pages" size={15} onClick={() => deletePagesAction()} />
          </div>
          <ThumbnailSidebar />
        </>
      ) : tab === "annotations" ? (
        <AnnotationList />
      ) : (
        <SignaturePanel />
      )}
    </aside>
  );
}
