import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { insertNode, moveNode, readOutline, removeNode, updateNode, writeOutline } from "./outline";

async function blank(n: number) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage();
  return doc.save();
}

describe("bookmarks", () => {
  it("writes and reads a nested outline", async () => {
    let tree = insertNode([], { title: "Giriş", page: 0, open: true, children: [] });
    tree = insertNode(tree, { title: "Bölüm 1", page: 1, open: true, children: [] }, tree[0].id);
    tree = insertNode(tree, { title: "1.1 Ayrıntılar", page: 2, open: false, children: [] }, tree[1].id);
    tree = moveNode(tree, tree[2].id, "in"); // becomes a child of "Bölüm 1"
    expect(tree).toHaveLength(2);
    expect(tree[1].children[0].title).toBe("1.1 Ayrıntılar");
    const out = await writeOutline(await blank(4), tree);
    const back = await readOutline(out);
    expect(back.map((n) => [n.title, n.page])).toEqual([
      ["Giriş", 0],
      ["Bölüm 1", 1],
    ]);
    expect(back[1].children.map((n) => [n.title, n.page])).toEqual([["1.1 Ayrıntılar", 2]]);
  });

  it("edits the tree", async () => {
    let tree = insertNode([], { title: "A", page: 0, open: true, children: [] });
    tree = insertNode(tree, { title: "B", page: 1, open: true, children: [] }, tree[0].id);
    tree = moveNode(tree, tree[1].id, "up");
    expect(tree.map((n) => n.title)).toEqual(["B", "A"]);
    tree = updateNode(tree, tree[0].id, { title: "B2" });
    tree = removeNode(tree, tree[1].id);
    expect(tree.map((n) => n.title)).toEqual(["B2"]);
    const out = await writeOutline(await blank(2), []);
    expect(await readOutline(out)).toEqual([]);
  });
});
