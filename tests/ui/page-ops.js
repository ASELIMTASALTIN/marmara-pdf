// Playwright UI test for page management. Run against `npm run dev` with sample.pdf open.
async (page) => {
  const state = () =>
    page.evaluate(async () => {
      const m = window.__marmara;
      const d = m.doc.getState();
      const out = [];
      for (let i = 1; i <= d.pdf.numPages; i++) {
        const p = await d.pdf.getPage(i);
        const tc = await p.getTextContent();
        const t = tc.items.map((x) => x.str).join(" ");
        out.push((t.match(/TOKEN\d/) || ["blank"])[0] + "@" + p.rotate);
      }
      return { pages: out.join(" "), ids: d.doc.pageIds.length, undo: d.undoStack.length, redo: d.redoStack.length, dirty: d.dirty };
    });
  const thumb = (i) => page.locator(`.thumb[data-index="${i}"] .thumb-frame`);
  const r = {};
  await page.waitForTimeout(800);
  r.initial = await state();

  await thumb(0).click();
  await page.keyboard.press("Control+r");
  await page.waitForTimeout(700);
  r.rotated = await state();

  await thumb(1).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Duplicate/ }).click();
  await page.waitForTimeout(700);
  r.duplicated = await state();

  await thumb(2).click();
  await page.keyboard.press("Delete");
  await page.waitForTimeout(700);
  r.deleted = await state();

  await thumb(4).scrollIntoViewIfNeeded();
  const src = await thumb(4).boundingBox();
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2 - 30, { steps: 5 });
  await thumb(0).scrollIntoViewIfNeeded().catch(() => {});
  // drag towards the top edge so the list auto-scrolls, then onto page 1's upper half
  const list = await page.locator(".thumb-list").boundingBox();
  await page.mouse.move(list.x + 60, list.y + 10, { steps: 10 });
  await page.waitForTimeout(600);
  const dst = await thumb(0).boundingBox();
  await page.mouse.move(dst.x + dst.width / 2, dst.y + 8, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  r.dragged = await state();

  await page.locator(".viewer").click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(700);
  r.undo = await state();
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(700);
  r.redo = await state();

  // insert blank page after page 1 via context menu
  await thumb(0).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Insert blank page after" }).click();
  await page.waitForTimeout(700);
  r.blank = await state();
  await page.screenshot({ path: ".playwright-mcp/pageops.png" });
  return r;
}
