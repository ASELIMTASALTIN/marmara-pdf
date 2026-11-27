import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import * as mupdf from "mupdf";
import { addFormField, fieldNames, removeFormField } from "./create";
import { applyFormValues } from "./forms";

async function blank() {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  return doc.save();
}

function widgets(bytes: Uint8Array) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
  const out = (doc.loadPage(0) as mupdf.PDFPage).getWidgets().map((w) => [w.getName(), w.getFieldType(), w.getValue()]);
  doc.destroy();
  return out;
}

describe("form creation", () => {
  it("creates every field type, which can then be filled", async () => {
    let b = await blank();
    b = await addFormField(b, { kind: "text", name: "ad", pageIndex: 0, rect: [100, 700, 300, 722] });
    b = await addFormField(b, { kind: "multiline", name: "notlar", pageIndex: 0, rect: [100, 600, 300, 680] });
    b = await addFormField(b, { kind: "checkbox", name: "onay", pageIndex: 0, rect: [100, 560, 116, 576] });
    b = await addFormField(b, { kind: "radio", name: "renk", pageIndex: 0, rect: [100, 520, 116, 536], options: ["kirmizi"] });
    b = await addFormField(b, { kind: "radio", name: "renk", pageIndex: 0, rect: [140, 520, 156, 536], options: ["mavi"] });
    b = await addFormField(b, { kind: "dropdown", name: "sehir", pageIndex: 0, rect: [100, 480, 250, 502], options: ["İstanbul", "Ankara"] });
    b = await addFormField(b, { kind: "signature", name: "imza", pageIndex: 0, rect: [300, 100, 500, 160] });
    expect((await fieldNames(b)).sort()).toEqual(["ad", "imza", "notlar", "onay", "renk", "sehir"].sort());
    const types = widgets(b).map((w) => w[1]);
    expect(types).toEqual(expect.arrayContaining(["text", "checkbox", "radiobutton", "combobox", "signature"]));
    // fill the new form
    const filled = await applyFormValues(b, { ad: "Ayşe", onay: true, renk: "mavi", sehir: "Ankara" });
    const vals = Object.fromEntries(widgets(filled).filter((w) => w[1] !== "radiobutton").map((w) => [w[0], w[2]]));
    expect(vals.ad).toBe("Ayşe");
    expect(vals.sehir).toBe("Ankara");
  });

  it("removes fields, including empty signature fields", async () => {
    let b = await addFormField(await blank(), { kind: "text", name: "x", pageIndex: 0, rect: [100, 700, 300, 722] });
    b = await addFormField(b, { kind: "signature", name: "imza", pageIndex: 0, rect: [300, 100, 500, 160] });
    b = await removeFormField(b, "x");
    b = await removeFormField(b, "imza");
    expect(widgets(b)).toHaveLength(0);
  });
});
