import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import * as mupdf from "mupdf";
import { applyFormValues } from "./forms";

export async function makeFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const form = doc.getForm();
  const name = form.createTextField("applicant.name");
  name.addToPage(page, { x: 50, y: 700, width: 250, height: 24 });
  const agree = form.createCheckBox("agree");
  agree.addToPage(page, { x: 50, y: 650, width: 18, height: 18 });
  const color = form.createRadioGroup("color");
  color.addOptionToPage("red", page, { x: 50, y: 600, width: 16, height: 16 });
  color.addOptionToPage("blue", page, { x: 90, y: 600, width: 16, height: 16 });
  const city = form.createDropdown("city");
  city.addOptions(["Istanbul", "Ankara", "Izmir"]);
  city.addToPage(page, { x: 50, y: 550, width: 150, height: 24 });
  return doc.save();
}

function fieldValues(bytes: Uint8Array): Record<string, string> {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()!;
  const out: Record<string, string> = {};
  for (const w of (doc.loadPage(0) as mupdf.PDFPage).getWidgets()) {
    const v = w.getValue();
    if (w.isRadioButton()) {
      if (v && v !== "Off") out[w.getName()] = v;
    } else out[w.getName()] = v;
  }
  doc.destroy();
  return out;
}

describe("form filling", () => {
  it("writes text, checkbox, radio and choice values", async () => {
    const out = await applyFormValues(await makeFormPdf(), {
      "applicant.name": "Ayşe Öztürk",
      agree: true,
      color: "blue",
      city: "Ankara",
    });
    const v = fieldValues(out);
    expect(v["applicant.name"]).toBe("Ayşe Öztürk");
    expect(v.agree).not.toBe("Off");
    expect(["blue", "1"]).toContain(v.color); // state name may be the /Opt index
    expect(v.city).toBe("Ankara");
  });

  it("can uncheck and leaves unspecified fields alone", async () => {
    const once = await applyFormValues(await makeFormPdf(), { agree: true, "applicant.name": "A" });
    const twice = await applyFormValues(once, { agree: false });
    const v = fieldValues(twice);
    expect(v.agree).toBe("Off");
    expect(v["applicant.name"]).toBe("A");
  });
});
