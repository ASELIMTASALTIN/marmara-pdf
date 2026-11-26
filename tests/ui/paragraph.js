// Playwright UI test: paragraph re-flow + Word export. test-fixtures/paragraph.pdf must be open.
async (page) => {
  const r = {};
  await page.waitForTimeout(800);
  await page.locator('[data-tool="edit-text"]').click();
  await page.waitForSelector('.page[data-page="1"] .te-block');
  const para = page.locator('.page[data-page="1"] .te-block[title*="paragraph"]').first();
  r.title = await para.getAttribute("title");
  await para.click();
  await page.waitForSelector(".te-input.para");
  const text = await page.locator(".te-input").inputValue();
  r.before = text.slice(0, 60);
  await page.locator(".te-input").fill(text.replace("When a sentence becomes longer,", "When a sentence becomes considerably longer than it was before,"));
  await page.screenshot({ path: ".playwright-mcp/para-editing.png" });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".te-input"), null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  r.toast = await page.locator(".toast").last().textContent();
  await page.locator('[data-tool="select"]').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: ".playwright-mcp/para-after.png" });
  // Word export -> download
  await page.locator('button[title="Export / convert"]').click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /Word document/ }).click()]);
  r.docx = download.suggestedFilename();
  await download.saveAs("C:/Users/ahmet/Desktop5/Marmara PDF/.playwright-mcp/ui-export.docx");
  return r;
}
