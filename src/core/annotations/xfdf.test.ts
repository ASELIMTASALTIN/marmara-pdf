import { describe, expect, it } from "vitest";
import { exportXfdf, importXfdf } from "./xfdf";
import type { AnnotationMap } from "./types";

let i = 0;
const id = () => `n${++i}`;
const base = { color: "#d1242f", opacity: 1, createdAt: Date.UTC(2026, 10, 27, 10, 0, 0), author: "Ayşe" };

describe("XFDF", () => {
  it("round-trips all comment types", () => {
    const map: AnnotationMap = {
      p1: [
        { ...base, id: "h", type: "highlight", rects: [[50, 700, 200, 715]], text: "önemli", color: "#ffd400", opacity: 0.45 },
        { ...base, id: "i", type: "ink", width: 2, paths: [[[10, 10], [20, 30]]] },
        { ...base, id: "r", type: "rect", rect: [100, 100, 200, 150], width: 2, fill: "#00ff00" },
        { ...base, id: "a", type: "arrow", from: [10, 300], to: [100, 320], width: 2 },
      ],
      p2: [
        { ...base, id: "f", type: "freetext", rect: [300, 500, 500, 540], text: "Şirket <notu> & ek", fontSize: 14 },
        { ...base, id: "n", type: "note", point: [550, 780], text: "Kontrol et" },
        { ...base, id: "s", type: "signature", rect: [1, 1, 2, 2], dataUrl: "data:," },
      ],
    };
    const xml = exportXfdf(map, ["p1", "p2"], "rapor.pdf");
    expect(xml).toContain("<highlight");
    expect(xml).toContain("&lt;notu&gt; &amp; ek");
    const { byPage, count, skipped } = importXfdf(xml, id);
    expect(count).toBe(6); // signature is not exported
    expect(skipped).toBe(0);
    const p0 = byPage.get(0)!;
    expect(p0.map((a) => a.type)).toEqual(["highlight", "ink", "rect", "arrow"]);
    const h = p0[0] as { rects: number[][]; text: string; author?: string };
    expect(h.rects[0]).toEqual([50, 700, 200, 715]);
    expect(h.author).toBe("Ayşe");
    const p1 = byPage.get(1)!;
    expect((p1[0] as { text: string }).text).toBe("Şirket <notu> & ek");
    expect(p1[1].type).toBe("note");
  });

  it("reads Acrobat-style XFDF", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve"><annots>
<text color="#FFFF00" creationdate="D:20260101120000Z" flags="print,nozoom,norotate" date="D:20260101120000Z" name="abc" icon="Comment" page="0" rect="100,700,120,720" subject="Note" title="Reviewer"><contents>Please check</contents></text>
<square color="#FF0000" page="0" rect="50,50,150,100" width="1.5" title="Reviewer"/>
<polygon page="0" rect="0,0,1,1"/>
</annots><f href="doc.pdf"/></xfdf>`;
    const { byPage, count, skipped } = importXfdf(xml, id);
    expect(count).toBe(2);
    expect(skipped).toBe(1);
    expect(byPage.get(0)![0]).toMatchObject({ type: "note", text: "Please check", author: "Reviewer" });
  });
});
