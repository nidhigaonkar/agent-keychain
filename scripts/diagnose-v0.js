#!/usr/bin/env node
// Diagnostic: open v0 billing, click Add Card, dump all frames/iframes after modal opens.
const { chromium } = require("playwright");
const path = require("path");
const os = require("os");

const PROFILE_DIR = path.join(os.homedir(), ".agent-keychain", "browser-profile");
const BILLING_URL = "https://v0.app/gaonkarnidhi1-2736/settings/billing";

(async () => {
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chrome",
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = await browser.newPage();

  await page.goto(BILLING_URL, { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(2000);

  const url = page.url();
  console.log("Current URL:", url);

  if (!url.includes("v0.app") || !url.includes("billing")) {
    console.log("Not on billing page — please log in manually, then press Enter.");
    await new Promise(r => process.stdin.once("data", r));
    await page.goto(BILLING_URL, { waitUntil: "load" }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  // Scroll to bottom to ensure Add Card is visible
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);

  // List all buttons
  const buttons = await page.$$eval("button", btns =>
    btns.map(b => ({ text: b.textContent?.trim().substring(0, 60), visible: b.offsetParent !== null }))
  );
  console.log("\nAll buttons on page:");
  buttons.forEach(b => console.log(`  [${b.visible ? "visible" : "hidden"}] "${b.text}"`));

  // Click Add Card
  const addCard = page.getByRole("button", { name: /add card/i }).first();
  const exists = await addCard.isVisible({ timeout: 5000 }).catch(() => false);
  if (!exists) {
    console.log("\nAdd Card button not visible! Taking screenshot...");
    await page.screenshot({ path: path.join(os.homedir(), ".agent-keychain", "diag-no-addcard.png"), fullPage: true });
    await browser.close();
    return;
  }

  console.log("\nClicking Add Card...");
  await addCard.click();

  // Progressively check for frames
  let elapsed = 0;
  let foundFrames = false;
  while (elapsed < 10000) {
    await page.waitForTimeout(500);
    elapsed += 500;
    const frames = page.frames();
    const iframes = await page.$$eval("iframe", els =>
      els.map(el => ({ title: el.title, name: el.name, src: el.src?.substring(0, 100) }))
    );
    if (frames.length > 1 || iframes.length > 0) {
      console.log(`\n--- Frames found at ${elapsed}ms ---`);
      console.log("page.frames() count:", frames.length);
      frames.forEach((f, i) =>
        console.log(`  frame[${i}]: name="${f.name()}" url="${f.url().substring(0, 100)}"`)
      );
      console.log("DOM iframes:", JSON.stringify(iframes, null, 2));
      foundFrames = true;
      break;
    }
  }

  if (!foundFrames) {
    console.log("\nNo iframes found after 10s.");
    // Check page content for clues
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    console.log("Page text snippet:", bodyText);
  }

  const screenshotPath = path.join(os.homedir(), ".agent-keychain", "diag-modal.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log("\nScreenshot saved to:", screenshotPath);

  console.log("\nKeeping browser open 20s for manual inspection...");
  await page.waitForTimeout(20000);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
