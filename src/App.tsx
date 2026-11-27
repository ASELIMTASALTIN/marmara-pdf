import { useEffect } from "react";
import { FileDown } from "lucide-react";
import { useDoc } from "./state/documentStore";
import { useUi } from "./state/uiStore";
import { TopBar } from "./components/layout/TopBar";
import { TabBar } from "./components/layout/TabBar";
import { Toolbar } from "./components/layout/Toolbar";
import { Sidebar } from "./components/sidebar/Sidebar";
import { Viewer } from "./components/viewer/Viewer";
import { SearchBar } from "./components/search/SearchBar";
import { HomeScreen } from "./components/home/HomeScreen";
import { BusyOverlay, DialogHost, Toasts } from "./components/common/DialogHost";
import { ContextMenuHost } from "./components/common/ContextMenu";
import { StyleBar } from "./components/layout/StyleBar";
import { useShortcuts } from "./hooks/useShortcuts";
import { useAppLifecycle } from "./hooks/useAppLifecycle";
import { toggleFullscreen } from "./actions/commands";
import { cancelEdit } from "./actions/textEditActions";
import { SignatureBanner } from "./components/signatures/SignaturePanel";
import { AssistantPanel } from "./components/assistant/AssistantPanel";
import { useAssistant } from "./state/assistantStore";

export default function App() {
  const hasDoc = useDoc((s) => !!s.doc);
  const fullscreen = useUi((s) => s.fullscreen);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const dropHover = useUi((s) => s.dropHover);
  const assistantOpen = useAssistant((s) => s.open);
  useShortcuts();
  useAppLifecycle();

  useEffect(() => {
    if (!hasDoc && fullscreen) void toggleFullscreen(false);
  }, [hasDoc, fullscreen]);

  // Leaving the Edit-text tool discards an open (unapplied) text editor.
  const tool = useUi((s) => s.tool);
  useEffect(() => {
    if (tool !== "edit-text") cancelEdit();
  }, [tool]);

  return (
    <div className={`app${fullscreen ? " fullscreen" : ""}`}>
      {!fullscreen && <TopBar />}
      {!fullscreen && hasDoc && <TabBar />}
      {!fullscreen && hasDoc && <Toolbar />}
      {!fullscreen && hasDoc && <StyleBar />}
      <main className="workspace">
        {hasDoc ? (
          <>
            {sidebarOpen && !fullscreen && <Sidebar />}
            <section className="document-area">
              <SearchBar />
              {!fullscreen && <SignatureBanner />}
              <Viewer />
              {fullscreen && (
                <button className="exit-fullscreen" onClick={() => toggleFullscreen(false)}>
                  Exit full screen (Esc)
                </button>
              )}
            </section>
            {assistantOpen && !fullscreen && <AssistantPanel />}
          </>
        ) : (
          <HomeScreen />
        )}
      </main>
      {dropHover && (
        <div className="drop-overlay">
          <div className="drop-card">
            <FileDown size={36} />
            <span>Drop PDF files to open or combine</span>
          </div>
        </div>
      )}
      <ContextMenuHost />
      <DialogHost />
      <Toasts />
      <BusyOverlay />
    </div>
  );
}
