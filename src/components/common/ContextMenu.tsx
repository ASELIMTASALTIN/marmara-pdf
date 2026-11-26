import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { LucideIcon } from "lucide-react";

export type MenuItem =
  | { kind?: "item"; label: string; icon?: LucideIcon; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | { kind: "separator" };

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[] } | null;
}
const useMenu = create<MenuState>(() => ({ menu: null }));

export function showContextMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) {
  e.preventDefault?.();
  useMenu.setState({ menu: { x: e.clientX, y: e.clientY, items } });
}
export const closeContextMenu = () => useMenu.setState({ menu: null });

export function ContextMenuHost() {
  const menu = useMenu((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 8),
      y: Math.min(menu.y, window.innerHeight - r.height - 8),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "pointerdown" && ref.current?.contains(e.target as Node)) return;
      closeContextMenu();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  if (!menu) return null;
  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((item, k) =>
        item.kind === "separator" ? (
          <div key={k} className="menu-sep" />
        ) : (
          <button
            key={k}
            role="menuitem"
            className={`menu-item${item.danger ? " danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              closeContextMenu();
              item.onSelect();
            }}
          >
            <span className="menu-icon">{item.icon && <item.icon size={15} />}</span>
            <span className="menu-label">{item.label}</span>
            {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
