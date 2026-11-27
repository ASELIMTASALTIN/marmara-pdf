import { describe, expect, it } from "vitest";
import { PDFDocument, rgb } from "pdf-lib";
import * as mupdf from "mupdf";
import { editPageObject, listPageObjects } from "./objects";

function makePng(r: number, g: number, b: number): Uint8Array {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 16, 16], false);
  const px = pix.getPixels();
  for (let i = 0; i < px.length; i += 3) [px[i], px[i + 1], px[i + 2]] = [r, g, b];
  return pix.asPNG().slice();
}
const PNG = makePng(0, 0, 255);

async function pdf() {
  const doc = await PDFDocument.create();
  const p = doc.addPage([600, 800]);
  p.drawRectangle({ x: 100, y: 500, width: 200, height: 100, color: rgb(1, 0, 0) });
  p.drawImage(await doc.embedPng(PNG), { x: 350, y: 100, width: 150, height: 150 });
  return doc.save();
}

/** Colour at (x, y) in PDF user space (y up). */
function colorAt(bytes: Uint8Array, x: number, y: number): number[] {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  const px = pix.getPixels();
  const i = ((800 - y) * pix.getWidth() + x) * 3;
  const out = [px[i], px[i + 1], px[i + 2]];
  doc.destroy();
  return out;
}

describe("page objects", () => {
  it("finds images and paths with their bounds", async () => {
    const objs = await listPageObjects(await pdf(), 0);
    const path = objs.find((o) => o.kind === "path")!;
    const img = objs.find((o) => o.kind === "image")!;
    expect(path.bbox.map(Math.round)).toEqual([100, 500, 300, 600]);
    expect(path.fill).toBe(true);
    expect(img.bbox.map(Math.round)).toEqual([350, 100, 500, 250]);
  });

  it("moves/resizes, recolours, deletes and replaces objects", async () => {
    const bytes = await pdf();
    const objs = await listPageObjects(bytes, 0);
    const path = objs.find((o) => o.kind === "path")!;
    expect(colorAt(bytes, 200, 550)).toEqual([255, 0, 0]);
    // move the rectangle down by 300
    const moved = await editPageObject(bytes, 0, path.id, { action: "transform", to: [100, 200, 300, 300] });
    expect(colorAt(moved, 200, 550)).toEqual([255, 255, 255]);
    expect(colorAt(moved, 200, 250)).toEqual([255, 0, 0]);
    // recolour
    const p2 = (await listPageObjects(moved, 0)).find((o) => o.kind === "path")!;
    const green = await editPageObject(moved, 0, p2.id, { action: "recolor", fill: "#00ff00" });
    expect(colorAt(green, 200, 250)).toEqual([0, 255, 0]);
    // delete the image
    const img = (await listPageObjects(green, 0)).find((o) => o.kind === "image")!;
    expect(colorAt(green, 425, 175)).not.toEqual([255, 255, 255]);
    const noImg = await editPageObject(green, 0, img.id, { action: "delete" });
    expect(colorAt(noImg, 425, 175)).toEqual([255, 255, 255]);
    // replace (on the earlier version)
    const replaced = await editPageObject(green, 0, img.id, { action: "replace-image", image: PNG });
    expect((await listPageObjects(replaced, 0)).filter((o) => o.kind === "image")).toHaveLength(1);
  });
});
