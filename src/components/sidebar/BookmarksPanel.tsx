import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, BookmarkPlus, ChevronDown, ChevronRight, IndentDecrease, IndentIncrease, Pencil, Trash2 } from "lucide-react";
import { commit, exclusive, useDoc } from "../../state/documentStore";
import { useUi } from "../../state/uiStore";
import { errorMessage, toast } from "../../state/dialogStore";
import { insertNode, moveNode, removeNode, updateNode, type OutlineNode } from "../../core/outline/outline";
import { viewer } from "../viewer/viewerController";
import { IconButton } from "../common/IconButton";

// The tree is cached per document bytes so it survives tab switches.
const cache = new WeakMap<Uint8Array, OutlineNode[]>();

export function BookmarksPanel() {
  const bytes = useDoc((s) => s.doc?.bytes);
  const [tree, setTree] = useState<OutlineNode[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    if (!bytes) return;
    const hit = cache.get(bytes);
    if (hit) {
      setTree(hit);
      return;
    }
    let alive = true;
    setTree(null);
    import("../../core/outline/outline")
      .then((m) => m.readOutline(bytes))
      .then((t) => {
        if (!alive) return;
        cache.set(bytes, t);
        setTree(t);
      })
      .catch(() => alive && setTree([]));
    return () => {
      alive = false;
    };
  }, [bytes]);

  const save = (next: OutlineNode[], label: string) => {
    setTree(next);
    void exclusive(async () => {
      const { doc } = useDoc.getState();
      if (!doc) return;
      try {
        const { writeOutline } = await import("../../core/outline/outline");
        const out = await writeOutline(doc.bytes, next);
        cache.set(out, next);
        await commit(label, { bytes: out });
      } catch (e) {
        toast(`Bookmarks could not be saved: ${errorMessage(e)}`, "error");
      }
    });
  };

  const add = () => {
    if (!tree) return;
    const page = useUi.getState().currentPage;
    const next = insertNode(tree, { title: `Page ${page + 1}`, page, open: true, children: [] }, selected ?? undefined);
    const created = findLastAdded(tree, next);
    save(next, "Add bookmark");
    if (created) {
      setSelected(created);
      setEditing(created);
    }
  };

  const render = (nodes: OutlineNode[], depth: number) =>
    nodes.map((n) => (
      <div key={n.id}>
        <div
          className={`bm-row${selected === n.id ? " selected" : ""}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => {
            setSelected(n.id);
            if (n.page >= 0) viewer.scrollToPage(n.page);
          }}
          onDoubleClick={() => setEditing(n.id)}
        >
          {n.children.length ? (
            <button
              className="bm-toggle"
              onClick={(e) => {
                e.stopPropagation();
                save(updateNode(tree!, n.id, { open: !n.open }), n.open ? "Collapse bookmark" : "Expand bookmark");
              }}
            >
              {n.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          ) : (
            <span className="bm-toggle" />
          )}
          {editing === n.id ? (
            <input
              autoFocus
              className="bm-edit"
              defaultValue={n.title}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setEditing(null);
              }}
              onBlur={(e) => {
                setEditing(null);
                const v = e.target.value.trim();
                if (v && v !== n.title) save(updateNode(tree!, n.id, { title: v }), "Rename bookmark");
              }}
            />
          ) : (
            <span className="bm-title" title={n.title}>
              {n.title}
            </span>
          )}
          {n.page >= 0 && <span className="bm-page">{n.page + 1}</span>}
        </div>
        {n.open && render(n.children, depth + 1)}
      </div>
    ));

  const sel = selected;
  return (
    <div className="bookmarks-panel">
      <div className="sidebar-actions">
        <IconButton icon={BookmarkPlus} label="Add bookmark for the current page" size={15} onClick={add} />
        <IconButton icon={Pencil} label="Rename" size={15} disabled={!sel} onClick={() => sel && setEditing(sel)} />
        <IconButton icon={ArrowUp} label="Move up" size={15} disabled={!sel} onClick={() => sel && save(moveNode(tree!, sel, "up"), "Move bookmark")} />
        <IconButton icon={ArrowDown} label="Move down" size={15} disabled={!sel} onClick={() => sel && save(moveNode(tree!, sel, "down"), "Move bookmark")} />
        <IconButton icon={IndentIncrease} label="Make child of previous" size={15} disabled={!sel} onClick={() => sel && save(moveNode(tree!, sel, "in"), "Indent bookmark")} />
        <IconButton icon={IndentDecrease} label="Move out one level" size={15} disabled={!sel} onClick={() => sel && save(moveNode(tree!, sel, "out"), "Outdent bookmark")} />
        <IconButton
          icon={Trash2}
          label="Delete bookmark"
          size={15}
          disabled={!sel}
          onClick={() => {
            if (!sel) return;
            save(removeNode(tree!, sel), "Delete bookmark");
            setSelected(null);
          }}
        />
      </div>
      <div className="bm-tree">
        {tree === null && <div className="empty-panel muted">Loading…</div>}
        {tree?.length === 0 && (
          <div className="empty-panel muted">
            No bookmarks yet.
            <br />
            Go to a page and press <BookmarkPlus size={12} /> to add one.
          </div>
        )}
        {tree && render(tree, 0)}
      </div>
    </div>
  );
}

function findLastAdded(before: OutlineNode[], after: OutlineNode[]): string | null {
  const ids = new Set<string>();
  const collect = (l: OutlineNode[]) => l.forEach((n) => (ids.add(n.id), collect(n.children)));
  collect(before);
  let found: string | null = null;
  const scan = (l: OutlineNode[]) =>
    l.forEach((n) => {
      if (!ids.has(n.id)) found = n.id;
      scan(n.children);
    });
  scan(after);
  return found;
}
