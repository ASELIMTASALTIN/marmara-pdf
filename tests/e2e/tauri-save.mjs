// E2E: annotate and save (overwrite) in the built app. App must be started with a PDF path.
import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts()[0].pages()[0];
const r = {};
await page.waitForSelector(".page canvas", { timeout: 20000 });
await page.waitForSelector('.page[data-page="1"] .textLayer span', { timeout: 20000 });
await page.waitForTimeout(1000);
await page.locator('[data-tool="select"]').click();
await page.locator('[data-tool="highlight"]').click();
const span = page.locator('.page[data-page="1"] .textLayer span', { hasText: "quick brown fox" }).first();
const b = await span.boundingBox();
await page.mouse.move(b.x + 2, b.y + b.height / 2);
await page.mouse.down();
await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(500);
r.annotations = await page.locator(".annot-shape").count();
await page.keyboard.press("Control+s");
// The overwrite confirmation is asked once per document.
if (await page.waitForSelector(".modal", { timeout: 3000 }).catch(() => null)) {
  r.dialog = await page.locator(".modal-title").textContent();
  await page.getByRole("button", { name: "Overwrite" }).click();
}
await page.waitForTimeout(2500);
r.toast = await page.locator(".toast").last().textContent();
r.dirtyDot = await page.locator(".dirty-dot").count();
console.log(JSON.stringify(r));
await browser.close().catch(() => {});
