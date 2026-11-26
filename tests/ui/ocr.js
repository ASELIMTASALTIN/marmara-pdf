// Playwright UI test for OCR. Run against `npm run dev` with test-fixtures/scanned.pdf open.
async (page) => {
  const r = {};
  const logs = [];
  page.on("console", (m) => m.type() === "error" && logs.push(m.text()));
  const pageText = (n) =>
    page.evaluate(async (n) => {
      const d = window.__marmara.doc.getState();
      const p = await d.pdf.getPage(n);
      return (await p.getTextContent()).items.map((i) => i.str).join(" ");
    }, n);
  await page.waitForTimeout(800);
  r.before = await pageText(1);
  await page.getByRole("button", { name: "OCR" }).click();
  await page.waitForSelector(".modal");
  r.dialog = (await page.locator(".modal-message").textContent()).slice(0, 80);
  await page.getByRole("button", { name: "Recognise text" }).click();
  const t0 = Date.now();
  await page.waitForFunction(() => window.__marmara.doc.getState().undoStack.length > 0 || document.querySelector(".toast.error"), null, { timeout: 240000 });
  r.seconds = Math.round((Date.now() - t0) / 1000);
  await page.waitForTimeout(1500);
  r.toast = await page.locator(".toast").last().textContent();
  r.page1 = await pageText(1);
  r.page2 = await pageText(2);
  // search recognised Turkish text
  await page.keyboard.press("Control+f");
  await page.keyboard.type("Yılmaz");
  await page.waitForTimeout(1500);
  r.search = await page.locator(".search-status").textContent();
  r.highlights = await page.locator(".search-hit").count();
  await page.keyboard.press("Escape");
  // run again on all pages: the OCR layer must be replaced, not duplicated
  await page.getByRole("button", { name: "OCR" }).click();
  await page.waitForSelector(".modal");
  r.dialog2 = (await page.locator(".modal-message").textContent()).slice(0, 60);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.screenshot({ path: ".playwright-mcp/ocr.png" });
  r.errors = logs.slice(0, 5);
  return r;
}
