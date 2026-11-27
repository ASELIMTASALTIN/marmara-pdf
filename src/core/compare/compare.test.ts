import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { compareDocuments, diffTokens } from "./compare";

async function pdf(lines: string[]) {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  lines.forEach((t, i) => p.drawText(t, { x: 50, y: 780 - i * 20, size: 12, font: f }));
  return doc.save();
}

describe("compare", () => {
  it("diffs token arrays", () => {
    const ops = diffTokens("a b c d".split(" "), "a x c d e".split(" "));
    const s = ops.map((o) => (o.t === "eq" ? "=" : o.t === "ins" ? "+" : "-")).join("");
    expect(s.replace(/=/g, "")).toMatch(/^(\+-|-\+)\+$/);
  });

  it("finds inserted and deleted words with positions", async () => {
    const a = await pdf(["The contract starts on 1 January 2026.", "Payment is due within 30 days.", "This line will be removed."]);
    const b = await pdf(["The contract starts on 1 March 2026.", "Payment is due within 45 days."]);
    const r = await compareDocuments(a, b);
    const ins = r.changes.filter((c) => c.kind === "inserted").map((c) => c.text);
    const del = r.changes.filter((c) => c.kind === "deleted").map((c) => c.text);
    expect(ins).toEqual(["March", "45"]);
    expect(del).toEqual(["January", "30", "This line will be removed."]);
    const march = r.changes.find((c) => c.text === "March")!;
    expect(march.words[0].rect[1]).toBeGreaterThan(770); // first line, PDF space
    expect(r.changes.find((c) => c.text === "January")!.anchor!.page).toBe(0);
  });

  it("reports no changes for identical documents", async () => {
    const a = await pdf(["Same text."]);
    const r = await compareDocuments(a, await pdf(["Same text."]));
    expect(r.changes).toHaveLength(0);
  });
});
