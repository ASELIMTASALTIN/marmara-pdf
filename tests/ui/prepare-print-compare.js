// Playwright UI test: create a form field, print (window.print stubbed), compare with the original.
// sample.pdf must be open and already modified (e.g. after tools.js). The compare step opens a file
// chooser: with the Playwright MCP, answer it with browser_file_upload (test-fixtures/sample.pdf) — the
// script waits for the result dialog.
async (page) => {
  const r = {};
  await page.evaluate(() => window.__marmara.ui.setState({ tool: "form", formFieldKind: "text" }));
  await page.waitForTimeout(300);
  const box = await page.locator(".page").first().boundingBox();
  const x = box.x + box.width * 0.3, y = box.y + box.height * 0.35;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 180, y + 28, { steps: 8 });
  await page.mouse.up();
  await page.waitForSelector(".modal", { timeout: 5000 });
  await page.locator(".modal input").first().fill("Ad Soyad");
  await page.locator(".modal").getByRole("button", { name: "Add field", exact: true }).click();
  await page.waitForFunction(() => window.__marmara.doc.getState().undoStack.some((s) => s.label.startsWith("Add text field")), null, { timeout: 15000 });
  await page.waitForTimeout(1200);
  r.prepFields = await page.locator(".form-prep-name").allInnerTexts();
  // Back to the select tool: the field is now fillable.
  await page.keyboard.press("Escape");
  await page.locator('[data-tool="select"]').click().catch(() => {});
  await page.waitForTimeout(800);
  r.fillableInputs = await page.locator(".form-layer:not(.preparing) .form-input").count();

  // Print: stub the system dialog and inspect what would be printed.
  await page.evaluate(() => {
    window.__printed = null;
    window.print = () => {
      const root = document.getElementById("print-root");
      window.__printed = root ? root.querySelectorAll("img").length : -1;
    };
  });
  await page.locator('button[aria-label="Print"]').click();
  await page.locator(".modal").getByRole("button", { name: /^Print/ }).click();
  await page.waitForFunction(() => window.__printed !== null, null, { timeout: 60000 });
  r.printedPages = await page.evaluate(() => window.__printed);

  // Compare: menu → file chooser (answered externally) → result dialog.
  await page.locator('button[title="Tools"]').click();
  await page.getByRole("menuitem", { name: /Compare/ }).click();
  return r;
}
