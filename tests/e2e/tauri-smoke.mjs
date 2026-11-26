// End-to-end smoke test of the *built* Tauri app via WebView2's remote debugging.
// Usage: start the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
//        then run: node tests/e2e/tauri-smoke.mjs
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts()[0].pages()[0];
const r = {};
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));

r.url = page.url();
await page.waitForSelector(".page canvas", { timeout: 20000 });
r.title = await page.title();
r.pages = await page.locator(".thumb-slot").count();

// search
await page.keyboard.press("Control+f");
await page.keyboard.type("lighthouse");
await page.waitForTimeout(1200);
r.search = await page.locator(".search-status").textContent();
await page.keyboard.press("Escape");

// annotation (mupdf runs at save time) + text edit (mupdf now)
await page.locator('[data-tool="edit-text"]').click();
await page.waitForSelector('.page[data-page="1"] .te-block', { timeout: 20000 });
await page.locator('.page[data-page="1"] .te-block').nth(1).click();
await page.locator(".te-input").fill("Edited inside the real Tauri app — ğüşıöç");
await page.keyboard.press("Enter");
await page.waitForFunction(() => !document.querySelector(".te-input") && !document.querySelector(".busy-overlay"), null, { timeout: 30000 });
await page.waitForTimeout(1500);
r.toastAfterEdit = await page.locator(".toast").last().textContent().catch(() => null);

// OCR worker + wasm must load under the production CSP
await page.locator('[data-tool="select"]').click();
await page.getByRole("button", { name: "OCR" }).click();
await page.waitForSelector(".modal");
await page.locator(".radio", { hasText: "Current page" }).click();
await page.getByRole("button", { name: "Recognise text" }).click();
await page.waitForFunction(() => document.querySelectorAll(".toast").length && /Recognis|No text|failed/.test(document.querySelector(".toast:last-child")?.textContent ?? ""), null, { timeout: 120000 });
r.toastAfterOcr = await page.locator(".toast").last().textContent();

await page.screenshot({ path: ".playwright-mcp/tauri-app.png" });
r.errors = errors.slice(0, 8);
console.log(JSON.stringify(r, null, 2));
await browser.close().catch(() => {});
