// Playwright UI test for form filling. Run against `npm run dev` with test-fixtures/form.pdf open.
async (page) => {
  const r = {};
  await page.waitForSelector(".form-layer .form-input", { timeout: 15000 });
  r.fields = await page.locator(".form-layer > *").count();
  const name = page.locator('.form-input[title="applicant.name"]');
  await name.click();
  await page.keyboard.type("Ayşe Öztürk");
  await page.keyboard.press("Enter");
  await page.locator('.form-input[title="comments"]').click();
  await page.keyboard.type("Line one\nLine two");
  await page.locator('.form-check[title="agree"]').click();
  await page.locator(".form-radio").nth(1).click();
  await page.locator('.form-select[title="city"]').selectOption("Ankara");
  await page.waitForTimeout(500);
  r.values = await page.evaluate(() => window.__marmara.doc.getState().formValues);
  r.undo = await page.evaluate(() => window.__marmara.doc.getState().undoStack.map((s) => s.label));
  await page.screenshot({ path: ".playwright-mcp/forms.png" });
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  await download.saveAs(".playwright-mcp/form-filled.pdf");
  r.saved = true;
  return r;
}
