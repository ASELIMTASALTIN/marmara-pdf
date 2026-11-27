// Playwright UI smoke test for Tools: header/footer, watermark, bookmarks, document check, compress, XFDF. sample.pdf open.
async (page) => {
  const r = {};
  const text = (n) => page.evaluate(async (n) => (await (await window.__marmara.doc.getState().pdf.getPage(n)).getTextContent()).items.map((i) => i.str).join(" "), n);
  const menu = async (item) => {
    await page.locator('button[title="Tools"]').click();
    await page.getByRole("menuitem", { name: item }).click();
  };
  await page.waitForTimeout(800);
  // header & footer with defaults
  await menu(/Header, footer/);
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForFunction(() => window.__marmara.doc.getState().undoStack.some((s) => s.label === "Header & footer"), null, { timeout: 20000 });
  await page.waitForTimeout(800);
  r.footer = (await text(2)).includes("Sayfa 2 / 5");
  // watermark
  await menu(/^Watermark/);
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForFunction(() => window.__marmara.doc.getState().undoStack.some((s) => s.label === "Watermark"), null, { timeout: 20000 });
  await page.waitForTimeout(800);
  r.watermark = (await text(1)).includes("TASLAK");
  r.footerKeptAfterWatermark = (await text(1)).includes("Sayfa 1 / 5");
  // bookmarks
  await page.getByRole("tab", { name: "Bookmarks" }).click();
  await page.locator('button[aria-label="Add bookmark for the current page"]').click();
  await page.waitForTimeout(400);
  await page.keyboard.type("Giriş");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  r.bookmarks = await page.locator(".bm-title").allInnerTexts();
  // document check
  await menu(/Document check/);
  await page.waitForSelector(".check-report", { timeout: 20000 });
  r.checkItems = await page.locator(".check-item").count();
  r.checkMessage = await page.locator(".modal-message").innerText();
  await page.locator(".modal").getByRole("button", { name: "Close", exact: true }).click();
  // compress (already small)
  await menu(/Reduce file size/);
  await page.getByRole("button", { name: "Compress" }).click();
  await page.waitForTimeout(2500);
  r.compressToast = await page.locator(".toast").last().innerText();
  await page.screenshot({ path: ".playwright-mcp/tools.png" });
  return r;
}
