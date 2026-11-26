import { useEffect } from "react";
import { commands, runCommand } from "../actions/commands";
import { useDoc } from "../state/documentStore";
import { useDialogs } from "../state/dialogStore";

/** Normalises a keyboard event to "Ctrl+Shift+Key" form. */
export function eventCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  if (key === "+" && parts.includes("Shift")) key = "=";
  parts.push(key);
  return parts.join("+");
}

function bindingMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of commands) {
    for (const k of [c.shortcut, ...(c.keys ?? [])]) {
      if (k && !k.includes("@")) map.set(k.replace(/\+([a-z])$/, (_, l: string) => `+${l.toUpperCase()}`), c.id);
    }
  }
  return map;
}

const NAV_KEYS = new Set(["PageDown", "PageUp", "Home", "End", "ArrowRight", "ArrowLeft"]);

export function useShortcuts() {
  useEffect(() => {
    const map = bindingMap();
    const onKey = (e: KeyboardEvent) => {
      const hardened = (e as KeyboardEvent & { marmaraHardened?: boolean }).marmaraHardened;
      if ((e.defaultPrevented && !hardened) || useDialogs.getState().dialogs.length) return; // handled locally / modal open
      const target = e.target as HTMLElement | null;
      const typing =
        !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      const combo = eventCombo(e);
      const id = map.get(combo);
      if (!id) return;
      const modified = e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key) || e.key === "Escape";
      // Plain keys (tool letters, arrows, Home/End) only apply when not typing.
      if (typing && !modified) return;
      // Arrow/page keys: only hijack when focus is on the viewer or body, and the viewer cannot scroll sideways.
      if (NAV_KEYS.has(combo)) {
        const inSidebar = !!target?.closest(".thumb-list");
        if (inSidebar) return;
        if ((combo === "ArrowRight" || combo === "ArrowLeft")) {
          const v = document.querySelector<HTMLElement>(".viewer");
          if (v && v.scrollWidth > v.clientWidth + 2) return;
        }
      }
      if (!useDoc.getState().doc && !["file.open", "file.combine", "view.sidebar"].includes(id)) return;
      e.preventDefault();
      runCommand(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
