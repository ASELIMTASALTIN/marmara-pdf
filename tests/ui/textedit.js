// Playwright UI test for text editing. Run against `npm run dev` with sample.pdf freshly open.
async (page) => {
  const r = {};
  const pageText = (n) =>
    page.evaluate(async (n) => {
      const d = window.__marmara.doc.getState();
      const p = await d.pdf.getPage(n);
      return (await p.getTextContent()).items.map((i) => i.str).join("|");
    }, n);
  await page.waitForTimeout(800);
  await page.locator('[data-tool="edit-text"]').click();
  await page.waitForSelector('.page[data-page="1"] .te-block', { timeout: 20000 });
  r.blocks = await page.locator('.page[data-page="1"] .te-block').count();

  // 1) edit an existing line in place (same characters available in Helvetica/WinAnsi)
  const line = page.locator('.page[data-page="1"] .te-block[title*="Helvetica"]').nth(1);
  await line.click();
  await page.waitForSelector(".te-input");
  r.original = await page.locator(".te-input").inputValue();
  await page.locator(".te-input").fill("Searching should find the word harbour on several pages.");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".busy-overlay") && !document.querySelector(".te-input"), null, { timeout: 15000 });
  await page.waitForTimeout(1200);
  r.toast1 = await page.locator(".toast").last().textContent();
  r.text1 = (await pageText(1)).includes("harbour");

  // 2) edit with Turkish characters -> re-typeset
  await page.waitForSelector('.page[data-page="1"] .te-block');
  const l2 = page.locator('.page[data-page="1"] .te-block[title*="Helvetica"]').nth(3);
  await l2.click();
  await page.waitForSelector(".te-input");
  await page.locator(".te-input").fill("İstanbul ve Boğaz iki kıtayı birleştirir.");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".te-input"), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  r.toast2 = await page.locator(".toast").last().textContent();
  r.text2 = (await pageText(1)).includes("Boğaz iki kıtayı");

  // 3) add new text on empty space
  const b = await page.locator('.page[data-page="1"]').boundingBox();
  await page.mouse.click(b.x + 120, b.y + 620);
  await page.waitForSelector(".te-input");
  await page.keyboard.type("Yeni eklenen metin — Marmara");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".te-input"), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  r.text3 = (await pageText(1)).includes("Yeni eklenen metin");

  // 4) undo the insertion, then redo
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(1200);
  r.afterUndo = (await pageText(1)).includes("Yeni eklenen metin");
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(1200);
  r.afterRedo = (await pageText(1)).includes("Yeni eklenen metin");
  r.undoLabels = await page.evaluate(() => window.__marmara.doc.getState().undoStack.map((s) => s.label));
  await page.screenshot({ path: ".playwright-mcp/textedit.png" });
  return r;
}
