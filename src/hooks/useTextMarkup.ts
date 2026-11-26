import { useEffect } from "react";
import { MARKUP_TOOLS, useUi } from "../state/uiStore";
import { pageRegistry } from "../components/viewer/pageRegistry";
import { mergeLineRects, viewRectToPdf } from "../core/annotations/geometry";
import type { Rect } from "../core/annotations/types";
import { addAnnotation } from "../actions/annotationActions";

/**
 * With a markup tool active (highlight / underline / strikethrough), selecting
 * text creates an annotation covering the selected lines — across pages too.
 */
export function useTextMarkup() {
  useEffect(() => {
    const onUp = () => {
      const { tool, toolStyles } = useUi.getState();
      if (!MARKUP_TOOLS.includes(tool)) return;
      // Let the browser finalise the selection first.
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const text = sel.toString().replace(/\s+/g, " ").trim();
        if (!text) return;
        const clientRects: DOMRect[] = [];
        for (let i = 0; i < sel.rangeCount; i++) clientRects.push(...Array.from(sel.getRangeAt(i).getClientRects()));
        const style = toolStyles[tool];
        let created = 0;
        for (const mp of pageRegistry.values()) {
          const layer = mp.element.querySelector(".textLayer");
          if (!layer || !sel.containsNode(layer, true)) continue;
          const box = mp.element.getBoundingClientRect();
          const pdfRects: Rect[] = [];
          for (const r of clientRects) {
            if (r.width < 0.5 || r.height < 0.5 || r.height > box.height * 0.5) continue;
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) continue;
            pdfRects.push(viewRectToPdf(mp.viewport, r.left - box.left, r.top - box.top, r.right - box.left, r.bottom - box.top));
          }
          const rects = mergeLineRects(pdfRects);
          if (!rects.length) continue;
          created++;
          void addAnnotation(mp.pageId, {
            type: tool as "highlight" | "underline" | "strikeout",
            rects,
            text,
            color: style.color,
            opacity: style.opacity,
          });
        }
        if (created) sel.removeAllRanges();
      });
    };
    document.addEventListener("pointerup", onUp);
    return () => document.removeEventListener("pointerup", onUp);
  }, []);
}
