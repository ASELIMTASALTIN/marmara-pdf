import { useEffect } from "react";
import { platform } from "../platform";
import { useDoc } from "../state/documentStore";
import { useUi } from "../state/uiStore";
import { confirmCloseAll, handleDroppedFiles, openPath, writeRecoverySnapshot } from "../actions/fileActions";

const AUTOSAVE_MS = 30_000;

/** Startup file, drag & drop, window title, close guard and crash-recovery autosave. */
export function useAppLifecycle() {
  // File passed on the command line ("Open with…").
  useEffect(() => {
    platform
      .startupFile()
      .then((p) => {
        if (p) void openPath(p);
      })
      .catch(() => {});
  }, []);

  // Drag & drop of files from the OS.
  useEffect(
    () =>
      platform.onFileDrop(
        (files) => void handleDroppedFiles(files),
        (hover) => useUi.setState({ dropHover: hover }),
      ),
    [],
  );

  // Window title reflects the document and unsaved state.
  const name = useDoc((s) => s.doc?.name);
  const dirty = useDoc((s) => s.dirty);
  useEffect(() => {
    void platform.setTitle(name ? `${dirty ? "• " : ""}${name} — Marmara PDF` : "Marmara PDF").catch(() => {});
  }, [name, dirty]);

  // Ask before closing the window with unsaved changes.
  useEffect(
    () =>
      platform.onCloseRequested(
        () => confirmCloseAll(),
        () => useDoc.getState().dirty,
      ),
    [],
  );

  // Periodic crash-recovery snapshots while there are unsaved changes.
  useEffect(() => {
    const id = setInterval(() => void writeRecoverySnapshot(), AUTOSAVE_MS);
    return () => clearInterval(id);
  }, []);

  // Production hardening: no browser reload / devtools shortcuts, no native context menu.
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r" && !e.shiftKey) || (e.ctrlKey && e.shiftKey && e.key === "I")) {
        // Ctrl+R is our "rotate" shortcut; prevent only the browser reload default
        // and mark the event so the shortcut handler still runs.
        e.preventDefault();
        (e as KeyboardEvent & { marmaraHardened?: boolean }).marmaraHardened = true;
      }
    };
    const menu = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("input, textarea, [contenteditable=true], .textLayer")) e.preventDefault();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("contextmenu", menu);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("contextmenu", menu);
    };
  }, []);
}
