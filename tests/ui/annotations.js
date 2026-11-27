// Playwright UI test for annotations. Run against `npm run dev` with sample.pdf open (fresh).
async (page) => {
  const r = {};
  const anns = () =>
    page.evaluate(() => {
      const d = window.__marmara.doc.getState();
      return Object.values(d.annotations).flat().map((a) => a.type + (a.text ? `:${a.text}` : ""));
    });
  const tool = async (name) => page.locator(`[data-tool="${name}"]`).click();
  const pageBox = async (n) => page.locator(`.page[data-page="${n}"]`).boundingBox();

  await page.waitForTimeout(800);
  let b = await pageBox(1);

  // 1) highlight by selecting the first body line with the mouse
  await tool("highlight");
  const span = page.locator('.page[data-page="1"] .textLayer span', { hasText: "quick brown fox" }).first();
  const sb = await span.boundingBox();
  await page.mouse.move(sb.x + 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width - 2, sb.y + sb.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  r.afterHighlight = await anns();

  // 2) ink stroke
  await tool("ink");
  await page.mouse.move(b.x + 100, b.y + 420);
  await page.mouse.down();
  for (let i = 0; i <= 20; i++) await page.mouse.move(b.x + 100 + i * 10, b.y + 420 + Math.sin(i / 3) * 30);
  await page.mouse.up();
  // 3) rectangle
  await tool("rect");
  await page.mouse.move(b.x + 400, b.y + 400);
  await page.mouse.down();
  await page.mouse.move(b.x + 560, b.y + 480, { steps: 5 });
  await page.mouse.up();
  // 4) arrow
  await tool("arrow");
  await page.mouse.move(b.x + 120, b.y + 560);
  await page.mouse.down();
  await page.mouse.move(b.x + 300, b.y + 520, { steps: 5 });
  await page.mouse.up();
  // 5) text box with Turkish text
  await tool("freetext");
  await page.mouse.click(b.x + 380, b.y + 600);
  await page.waitForTimeout(300);
  await page.keyboard.type("Merhaba dünya — ğüşıöç");
  await page.mouse.click(b.x + 60, b.y + 700); // blur commits
  await page.waitForTimeout(300);
  // 6) sticky note
  await tool("note");
  await page.mouse.click(b.x + 650, b.y + 300);
  await page.waitForTimeout(300);
  await page.keyboard.type("Kontrol edilecek");
  await page.locator(".viewer").click({ position: { x: 5, y: 300 } });
  await page.waitForTimeout(400);
  r.afterCreate = await anns();
  await page.screenshot({ path: ".playwright-mcp/annots1.png" });

  // 7) select + move the rectangle, then delete it with the Delete key
  await tool("select");
  await page.mouse.click(b.x + 400, b.y + 440); // on the left edge of the rect
  await page.waitForTimeout(200);
  r.selected = await page.evaluate(() => window.__marmara.ui.getState().selectedAnnotation !== null);
  const before = await page.evaluate(() => JSON.stringify(Object.values(window.__marmara.doc.getState().annotations).flat().find((a) => a.type === "rect").rect));
  await page.mouse.move(b.x + 400, b.y + 440);
  await page.mouse.down();
  await page.mouse.move(b.x + 450, b.y + 470, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => JSON.stringify(Object.values(window.__marmara.doc.getState().annotations).flat().find((a) => a.type === "rect").rect));
  r.moved = before !== after;
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  r.afterDelete = await anns();

  // 8) eraser on the ink stroke
  await tool("eraser");
  await page.mouse.move(b.x + 90, b.y + 400);
  await page.mouse.down();
  for (let i = 0; i <= 24; i++) await page.mouse.move(b.x + 90 + i * 10, b.y + 420 + Math.sin(i / 3) * 30, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  r.afterErase = await anns();

  // 9) undo brings the ink back
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  r.afterUndo = await anns();

  // 10) save -> browser download, keep the file for inspection
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const path = ".playwright-mcp/annotated.pdf";
  await download.saveAs(path);
  r.saved = download.suggestedFilename();
  r.dirtyAfterSave = await page.evaluate(() => window.__marmara.doc.getState().dirty);
  await page.screenshot({ path: ".playwright-mcp/annots2.png" });
  return r;
}
