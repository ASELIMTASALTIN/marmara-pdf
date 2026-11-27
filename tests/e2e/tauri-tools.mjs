// End-to-end check of the Tools features in the *built* app (sample.pdf open, unmodified).
// Usage: start the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
//        then run: node tests/e2e/tauri-tools.mjs
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts()[0].pages()[0];
const r = {};
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.waitForSelector(".page canvas", { timeout: 20000 });

const menu = async (item) => {
  await page.locator('button[title="Tools"]').click();
  await page.getByRole("menuitem", { name: item }).click();
};
const pageText = async () => ((await page.locator('.page[data-page="1"] .textLayer').innerText().catch(() => "")) || "").replace(/\s+/g, " ");
const waitText = async (t) => {
  for (let i = 0; i < 120; i++) {
    if ((await pageText()).includes(t)) return true;
    await page.waitForTimeout(250);
  }
  return false;
};

await menu(/Header, footer/);
await page.locator(".modal").getByRole("button", { name: "Apply" }).click();
r.headerFooter = await waitText("Sayfa 1 / 5");
await menu(/^Watermark/);
await page.locator(".modal").getByRole("button", { name: "Apply" }).click();
r.watermark = await waitText("TASLAK");
r.footerKept = (await pageText()).includes("Sayfa 1 / 5");

await page.getByRole("tab", { name: "Bookmarks" }).click();
await page.locator('button[aria-label="Add bookmark for the current page"]').click();
await page.waitForTimeout(400);
await page.keyboard.type("Giriş");
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);
r.bookmarks = await page.locator(".bm-title").allInnerTexts();

await menu(/Document check/);
await page.waitForSelector(".check-report", { timeout: 30000 });
r.check = await page.locator(".modal-message").innerText();
await page.locator(".modal").getByRole("button", { name: "Close", exact: true }).click();

await page.locator('button[aria-label="Print"]').click();
r.printDialog = await page.locator(".modal").getByRole("button", { name: /^Print/ }).isVisible();
await page.locator(".modal").getByRole("button", { name: "Cancel" }).click();

r.errors = errors;
console.log(JSON.stringify(r, null, 2));
await browser.close();
