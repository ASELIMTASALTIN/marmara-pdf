// End-to-end check of the Assistant, dark mode and update check in the *built* app.
// Start the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 and
// sample.pdf, then: node tests/e2e/tauri-assistant.mjs
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts()[0].pages()[0];
const r = {};
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.waitForSelector(".page canvas", { timeout: 30000 });

// Assistant: engine starts from the app, model loads, a request edits the document.
const t0 = Date.now();
await page.keyboard.press("Control+j");
await page.waitForSelector(".assistant", { timeout: 5000 });
try {
  await page.waitForSelector(".assistant-composer textarea:not([disabled])", { timeout: 180000 });
} catch {
  r.engineCard = await page.locator(".assistant-card").innerText().catch(() => "");
  console.log(JSON.stringify(r, null, 2));
  process.exit(1);
}
r.engineReadySeconds = Math.round((Date.now() - t0) / 1000);
r.badge = await page.locator(".assistant-badge").innerText();
const ask = async (text) => {
  const before = await page.locator(".assistant-msg.assistant, .assistant-msg.error").count();
  await page.locator(".assistant-composer textarea").fill(text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => !document.querySelector(".assistant-send.stop") && document.querySelectorAll(".assistant-msg.assistant, .assistant-msg.error").length > n, before, { timeout: 180000 });
  const answers = await page.locator(".assistant-msg.assistant, .assistant-msg.error").allInnerTexts();
  return { steps: await page.locator(".assistant-step").allInnerTexts(), answer: answers[answers.length - 1] };
};
r.highlight = await ask("lighthouse kelimesini vurgula");
r.pageNumbers = await ask("Her sayfanın altına ortada 'Sayfa {page} / {pages}' ekle");
r.pageText = (await page.locator('.page[data-page="2"] .textLayer').innerText().catch(() => "")).includes("Sayfa 2 / 5");

// Dark mode.
await page.locator('button[aria-label="Switch to dark theme"]').click();
r.theme = await page.evaluate(() => document.documentElement.dataset.theme);
await page.screenshot({ path: ".playwright-mcp/tauri-assistant-dark.png" });
await page.locator('button[aria-label="Switch to light theme"]').click();

// Update check: answers with a dialog (up to date / update available / cannot check).
await page.locator('button[aria-label="Settings & updates"]').click();
await page.getByRole("menuitem", { name: /Check for updates/ }).click();
await page.waitForSelector(".modal", { timeout: 30000 });
r.updateDialog = (await page.locator(".modal").innerText()).replace(/\s+/g, " ").slice(0, 300);
await page.locator(".modal button").first().click();

r.errors = errors;
console.log(JSON.stringify(r, null, 2));
await browser.close();
