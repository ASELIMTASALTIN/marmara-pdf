// End-to-end check of "Check for updates" against the published GitHub release, without installing:
// build an app that reports an older version (tauri build --no-bundle --config {"version":"0.1.99"}),
// start it with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223, then run this.
// It checks the UI dialog, then downloads the update through the updater plugin, which verifies
// the installer's signature against the public key built into the app.
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts()[0].pages()[0];
const r = {};
await page.waitForLoadState();
await page.waitForTimeout(1500);
await page.locator('button[aria-label="Settings & updates"]').click();
await page.getByRole("menuitem", { name: /Check for updates/ }).click();
await page.waitForSelector(".modal", { timeout: 30000 });
r.dialog = (await page.locator(".modal").innerText()).replace(/\s+/g, " ").slice(0, 200);
await page.locator(".modal").getByRole("button", { name: "Later" }).click();

r.download = await page.evaluate(async () => {
  const T = window.__TAURI_INTERNALS__;
  const meta = await T.invoke("plugin:updater|check", { timeout: 20000 });
  if (!meta) return { available: false };
  let bytes = 0;
  const id = T.transformCallback((msg) => {
    const ev = msg?.message ?? msg;
    if (ev?.event === "Progress") bytes += ev.data.chunkLength;
  });
  try {
    await T.invoke("plugin:updater|download", { onEvent: `__CHANNEL__:${id}`, rid: meta.rid });
    return { available: true, version: meta.version, current: meta.currentVersion, downloadedAndVerified: true, bytes };
  } catch (e) {
    return { available: true, version: meta.version, error: String(e) };
  }
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
