// Playwright UI test: create a digital ID, sign visibly, verify the banner/panel. sample.pdf must be open.
async (page) => {
  const r = {};
  await page.evaluate(() => localStorage.removeItem("marmara.digitalIds"));
  await page.waitForTimeout(500);
  await page.locator('button[title="Digital signatures"]').click();
  await page.getByRole("menuitem", { name: /Sign digitally/ }).click();
  await page.getByRole("button", { name: "Create digital ID…" }).click();
  const field = (label) => page.locator(".modal .field", { hasText: label }).locator("input");
  await field("Full name").fill("Ayşe Yılmaz");
  await field("E-mail").fill("ayse@example.com");
  await field("Password (protects").fill("secret123");
  await field("Repeat password").fill("secret123");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForSelector(".modal-title:text('Sign digitally')", { timeout: 20000 });
  await page.locator(".modal .field", { hasText: "Location" }).locator("input").fill("İstanbul");
  await page.getByRole("button", { name: "Continue" }).click();
  // draw the signature box
  await page.waitForTimeout(300);
  const b = await page.locator('.page[data-page="1"]').boundingBox();
  await page.mouse.move(b.x + b.width - 300, b.y + 420);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 60, b.y + 500, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector(".modal-title:text('Unlock digital ID')");
  await page.locator(".modal input").fill("wrong-password");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  r.wrongPasswordToast = await page.locator(".toast.error").last().textContent();
  await page.locator(".modal input").fill("secret123");
  const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Enter")]);
  r.downloaded = download.suggestedFilename();
  await download.saveAs("C:/Users/ahmet/Desktop5/Marmara PDF/.playwright-mcp/ui-signed.pdf");
  await page.waitForSelector(".sig-banner", { timeout: 20000 });
  r.banner = await page.locator(".sig-banner").textContent();
  await page.getByRole("button", { name: "Signature panel" }).click();
  await page.waitForSelector(".sig-item");
  r.panel = await page.locator(".sig-item").first().innerText();
  await page.waitForTimeout(800);
  await page.screenshot({ path: ".playwright-mcp/ui-signed.png" });
  return r;
}
