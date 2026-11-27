// Playwright UI test: open two documents as tabs, edit one, switch, close. sample.pdf must be open.
async (page) => {
  const r = {};
  await page.waitForTimeout(600);
  // open a second document through the toolbar (file chooser handled by the caller via setInputFiles)
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.locator('button[title^="Open"]').first().click()]);
  await fc.setFiles("C:/Users/ahmet/Desktop5/Marmara PDF/test-fixtures/paragraph.pdf");
  await page.waitForSelector(".tabbar .doc-tab:nth-child(2)", { timeout: 10000 });
  r.tabs = await page.locator(".doc-tab").allInnerTexts();
  r.activeName = await page.locator(".doc-tab.active").innerText();
  // modify the active doc (rotate) -> dirty dot in its tab
  await page.locator(".viewer").click({ position: { x: 10, y: 200 } });
  await page.keyboard.press("Control+r");
  await page.waitForTimeout(800);
  r.dirtyTabs = await page.locator(".doc-tab .dirty-dot").count();
  // switch to the first tab: its page count is 5
  await page.locator(".doc-tab").first().click();
  await page.waitForTimeout(800);
  r.firstPages = await page.locator(".page-count").innerText();
  // back to second: still rotated (undo available)
  await page.locator(".doc-tab").nth(1).click();
  await page.waitForTimeout(800);
  r.secondUndo = await page.evaluate(() => window.__marmara.doc.getState().undoStack.length);
  // close second tab (dirty) -> discard
  await page.locator(".doc-tab").nth(1).locator(".doc-tab-close").click();
  await page.getByRole("button", { name: "Don't save" }).click();
  await page.waitForTimeout(600);
  r.afterClose = await page.locator(".doc-tab").count();
  r.title = await page.title();
  return r;
}
