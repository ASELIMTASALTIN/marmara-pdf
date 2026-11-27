// Playwright UI test: the Assistant side panel drives the open document with the local model.
// Needs the engine on 127.0.0.1:8080 (npm run dev uses it in the browser) and sample.pdf open (fresh).
async (page) => {
  const r = {};
  const ask = async (text, timeout = 90000) => {
    const before = await page.locator(".assistant-msg.assistant").count();
    await page.locator(".assistant-composer textarea").fill(text);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (n) => !document.querySelector(".assistant-send.stop") && document.querySelectorAll(".assistant-msg.assistant, .assistant-msg.error").length > n,
      before,
      { timeout },
    );
    const steps = await page.locator(".assistant-step").allInnerTexts();
    const answers = await page.locator(".assistant-msg.assistant, .assistant-msg.error").allInnerTexts();
    return { steps, answer: answers[answers.length - 1] };
  };
  await page.waitForTimeout(600);
  await page.keyboard.press("Control+j");
  await page.waitForSelector(".assistant", { timeout: 5000 });
  await page.waitForSelector(".assistant-composer textarea:not([disabled])", { timeout: 120000 });
  r.badge = await page.locator(".assistant-badge").innerText();
  const undo = () => page.evaluate(() => window.__marmara.doc.getState().undoStack.map((s) => s.label));
  r.highlight = await ask("lighthouse kelimesini yeşil ile vurgula");
  r.highlightCount = await page.evaluate(() => Object.values(window.__marmara.doc.getState().annotations).flat().filter((a) => a.type === "highlight").length);
  r.pageNumbers = await ask("Her sayfanın altına ortaya 'Sayfa X / Y' biçiminde sayfa numarası ekle");
  r.footerText = await page.evaluate(async () => (await (await window.__marmara.doc.getState().pdf.getPage(2)).getTextContent()).items.map((i) => i.str).join(" ").includes("Sayfa 2 / 5"));
  r.summary = await ask("Bu sayfada ne yazıyor? Kısaca özetle.");
  r.rotate = await ask("3. sayfayı 90 derece döndür");
  r.rotated = await page.evaluate(async () => (await window.__marmara.doc.getState().pdf.getPage(3)).rotate);
  r.undoLabels = await undo();
  await page.screenshot({ path: ".playwright-mcp/assistant.png" });
  return r;
}
