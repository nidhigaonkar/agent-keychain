// Anthropic billing checkout automation.
// Navigates to platform.claude.com/settings/billing, clicks through the
// "Add credits" flow, fills Stripe card form, submits.

const DEFAULT_TIMEOUT = 15000;

async function run(page, provider, card, { dryRun }) {
  await page.goto(provider.billing_url, { waitUntil: "networkidle" });

  const currentUrl = page.url();
  if (currentUrl.includes("/login") || currentUrl.includes("/auth") || !currentUrl.includes("platform.claude.com")) {
    console.log(`\nNot logged in to Anthropic (landed on: ${currentUrl})`);
    console.log("Please log in in the browser window. The script will continue automatically once you reach the billing page.");
    await page.waitForURL("**/settings/**", { timeout: 120000 });
    await page.waitForLoadState("networkidle");
  }

  if (!page.url().includes("billing")) {
    await page.goto(provider.billing_url, { waitUntil: "networkidle" });
  }

  console.log("On billing page. Looking for credit top-up option...");

  // Anthropic shows a "Buy credits" or "Add credits" button
  const addCreditsBtn = page
    .getByRole("button", { name: /buy credits|add credits|purchase credits/i })
    .first();
  await addCreditsBtn.waitFor({ timeout: DEFAULT_TIMEOUT });
  await addCreditsBtn.click();

  // Amount selection — Anthropic may show preset amounts or a custom input
  console.log("Selecting top-up amount...");
  const amountLabel = `$${provider.suggested_topup_amount_usd}`;

  // Try clicking a preset amount tile first
  const presetTile = page.getByRole("button", { name: amountLabel }).first();
  const presetVisible = await presetTile.isVisible({ timeout: 3000 }).catch(() => false);

  if (presetVisible) {
    await presetTile.click();
  } else {
    // Fall back to a text input
    const customInput = page
      .getByRole("spinbutton")
      .or(page.locator('input[type="number"]'))
      .first();
    await customInput.waitFor({ timeout: DEFAULT_TIMEOUT });
    await customInput.fill(String(provider.suggested_topup_amount_usd));
  }

  // Stripe Elements card form
  console.log("Filling card details...");
  await fillStripeElements(page, card);

  if (dryRun) {
    console.log("DRY RUN: skipping submit.");
    return;
  }

  const submitBtn = page
    .getByRole("button", { name: /confirm|pay|purchase|buy now|add credits/i })
    .last();
  await submitBtn.waitFor({ timeout: DEFAULT_TIMEOUT });
  await submitBtn.click();

  await page
    .getByText(/payment successful|credits added|purchase complete|thank you/i)
    .waitFor({ timeout: 30000 });

  console.log("Anthropic credit top-up confirmed.");
}

async function fillStripeElements(page, card) {
  const expiry = `${String(card.exp_month).padStart(2, "0")}/${String(card.exp_year).slice(-2)}`;

  const unifiedFrame = page
    .frameLocator('iframe[name^="__privateStripeFrame"]')
    .first();

  const isUnified = await unifiedFrame
    .locator('[placeholder*="1234"]')
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  if (isUnified) {
    await unifiedFrame.locator('[placeholder*="1234"]').fill(card.number);
    await unifiedFrame.locator('[placeholder*="MM / YY"]').fill(expiry);
    await unifiedFrame.locator('[placeholder*="CVC"]').fill(card.cvc);
  } else {
    const numberInput = page
      .frameLocator('iframe[title*="card number" i]')
      .locator('[name="cardnumber"], [placeholder*="Card number"]');
    await numberInput.fill(card.number);

    const expiryInput = page
      .frameLocator('iframe[title*="expiration" i]')
      .locator('[name="exp-date"], [placeholder*="MM"]');
    await expiryInput.fill(expiry);

    const cvcInput = page
      .frameLocator('iframe[title*="CVC" i], iframe[title*="security" i]')
      .locator('[name="cvc"], [placeholder*="CVC"]');
    await cvcInput.fill(card.cvc);
  }

  const zipInput = page.locator('[name="postalCode"], [placeholder*="ZIP"]').first();
  const zipVisible = await zipInput.isVisible({ timeout: 2000 }).catch(() => false);
  if (zipVisible && card.billing_address?.postal_code) {
    await zipInput.fill(card.billing_address.postal_code);
  }
}

async function waitForKeypress() {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    });
  });
}

module.exports = { run };
