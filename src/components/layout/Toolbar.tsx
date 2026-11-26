import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Circle,
  Eraser,
  Hand,
  Highlighter,
  ImagePlus,
  Minus,
  MousePointer2,
  MoveUpRight,
  PanelLeft,
  PenLine,
  ScanText,
  Signature,
  Square,
  StickyNote,
  Strikethrough,
  TextCursorInput,
  Type,
  Underline,
  ZoomIn,
  ZoomOut,
  MoveHorizontal,
  Scan,
  type LucideIcon,
} from "lucide-react";
import { useDoc } from "../../state/documentStore";
import { setZoom, useUi, zoomStep, type Tool } from "../../state/uiStore";
import { activateTool } from "../../actions/toolActions";
import { runCommand } from "../../actions/commands";
import { viewer } from "../viewer/viewerController";
import { IconButton } from "../common/IconButton";

interface ToolDef {
  tool: Tool;
  icon: LucideIcon;
  label: string;
  command?: string;
}

const TOOL_GROUPS: ToolDef[][] = [
  [
    { tool: "select", icon: MousePointer2, label: "Select", command: "tool.select" },
    { tool: "hand", icon: Hand, label: "Hand (pan)", command: "tool.hand" },
  ],
  [
    { tool: "highlight", icon: Highlighter, label: "Highlight text", command: "tool.highlight" },
    { tool: "underline", icon: Underline, label: "Underline text" },
    { tool: "strikeout", icon: Strikethrough, label: "Strikethrough text" },
  ],
  [
    { tool: "ink", icon: PenLine, label: "Freehand draw", command: "tool.ink" },
    { tool: "rect", icon: Square, label: "Rectangle", command: "tool.rect" },
    { tool: "ellipse", icon: Circle, label: "Ellipse" },
    { tool: "line", icon: Minus, label: "Line" },
    { tool: "arrow", icon: MoveUpRight, label: "Arrow" },
  ],
  [
    { tool: "freetext", icon: Type, label: "Text box", command: "tool.freetext" },
    { tool: "note", icon: StickyNote, label: "Sticky note", command: "tool.note" },
    { tool: "signature", icon: Signature, label: "Signature" },
    { tool: "image", icon: ImagePlus, label: "Image" },
    { tool: "eraser", icon: Eraser, label: "Eraser (remove annotations)", command: "tool.eraser" },
  ],
];

function PageNav() {
  const current = useUi((s) => s.currentPage);
  const count = useDoc((s) => s.pageSizes.length);
  const [text, setText] = useState(String(current + 1));
  useEffect(() => setText(String(current + 1)), [current]);
  const commit = () => {
    const p = parseInt(text, 10);
    if (p >= 1 && p <= count) viewer.scrollToPage(p - 1);
    else setText(String(current + 1));
  };
  return (
    <div className="page-nav">
      <IconButton icon={ChevronUp} label="Previous page" command="nav.prev" disabled={current <= 0} onClick={() => runCommand("nav.prev")} />
      <IconButton icon={ChevronDown} label="Next page" command="nav.next" disabled={current >= count - 1} onClick={() => runCommand("nav.next")} />
      <input
        className="page-input"
        aria-label="Current page"
        value={text}
        onChange={(e) => setText(e.target.value.replace(/\D/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        onBlur={commit}
        onFocus={(e) => e.target.select()}
      />
      <span className="page-count">/ {count}</span>
    </div>
  );
}

const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function ZoomControls() {
  const zoom = useUi((s) => s.zoom);
  const mode = useUi((s) => s.zoomMode);
  return (
    <div className="zoom-controls">
      <IconButton icon={ZoomOut} label="Zoom out" command="view.zoomOut" onClick={() => setZoom(zoomStep(zoom, -1))} />
      <select
        className="zoom-select"
        aria-label="Zoom level"
        value={mode === "custom" ? "custom" : mode}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "fit-width" || v === "fit-page") useUi.setState({ zoomMode: v });
          else if (v !== "custom") setZoom(parseFloat(v));
        }}
      >
        <option value="custom">{Math.round(zoom * 100)}%</option>
        <option value="fit-width">Fit width</option>
        <option value="fit-page">Fit page</option>
        {ZOOM_PRESETS.map((z) => (
          <option key={z} value={z}>
            {z * 100}%
          </option>
        ))}
      </select>
      <IconButton icon={ZoomIn} label="Zoom in" command="view.zoomIn" onClick={() => setZoom(zoomStep(zoom, 1))} />
      <IconButton icon={MoveHorizontal} label="Fit width" command="view.fitWidth" active={mode === "fit-width"} onClick={() => useUi.setState({ zoomMode: "fit-width" })} />
      <IconButton icon={Scan} label="Fit page" command="view.fitPage" active={mode === "fit-page"} onClick={() => useUi.setState({ zoomMode: "fit-page" })} />
    </div>
  );
}

export function Toolbar() {
  const tool = useUi((s) => s.tool);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const pick = (t: Tool) => void activateTool(t);

  return (
    <div className="toolbar" role="toolbar" aria-label="Tools">
      <IconButton icon={PanelLeft} label="Toggle sidebar" command="view.sidebar" active={sidebarOpen} onClick={() => runCommand("view.sidebar")} />
      <span className="divider" />
      {TOOL_GROUPS.map((group, g) => (
        <div className="tool-group" key={g}>
          {group.map((d) => (
            <IconButton key={d.tool} icon={d.icon} label={d.label} command={d.command} active={tool === d.tool} onClick={() => pick(d.tool)} data-tool={d.tool} />
          ))}
        </div>
      ))}
      <div className="tool-group">
        <IconButton icon={TextCursorInput} label="Edit text" command="tool.editText" showLabel active={tool === "edit-text"} onClick={() => pick("edit-text")} data-tool="edit-text" />
        <IconButton icon={ScanText} label="OCR" showLabel onClick={() => runCommand("ocr.run")} />
      </div>
      <div className="toolbar-spacer" />
      <PageNav />
      <span className="divider" />
      <ZoomControls />
    </div>
  );
}
