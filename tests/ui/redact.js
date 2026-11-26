// Playwright UI test: find & mark, area mark, apply redactions. sample.pdf must be open.
async (page) => {
  const r = {};
  const allText = () =>
    page.evaluate(async () => {
      const d = window.__marmara.doc.getState();
      let t = "";
      for (let i = 1; i <= d.pdf.numPages; i++) t += (await (await d.pdf.getPage(i)).getTextContent()).items.map((x) => x.str).join(" ");
      return t;
    });
  await page.waitForTimeout(800);
  r.before = (await allText()).split("lighthouse").length - 1;
  await page.locator('[data-tool="redact"]').click();
  await page.getByRole("button", { name: /Find & mark/ }).click();
  await page.locator(".modal input[type=text]").first().fill("lighthouse");
  await page.getByRole("button", { name: "Mark all" }).click();
  await page.waitForTimeout(1500);
  r.marks = await page.locator(".stylebar .btn.danger").textContent();
  // also mark an area by dragging
  const b = await page.locator('.page[data-page="1"]').boundingBox();
  await page.mouse.move(b.x + 40, b.y + 280);
  await page.mouse.down();
  await page.mouse.move(b.x + 400, b.y + 310, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.screenshot({ path: ".playwright-mcp/redact-marks.png" });
  await page.locator(".stylebar .btn.danger").click();
  await page.getByRole("button", { name: "Apply redactions" }).last().click();
  await page.waitForFunction(() => window.__marmara.doc.getState().undoStack.some((s) => s.label === "Apply redactions"), null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  r.after = (await allText()).split("lighthouse").length - 1;
  r.toast = await page.locator(".toast").last().textContent();
  await page.screenshot({ path: ".playwright-mcp/redact-after.png" });
  return r;
}
