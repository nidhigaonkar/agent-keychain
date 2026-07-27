// Anthropic billing checkout automation.
// Handles two cases:
//   Saved card — a Stripe Link card is already on file; just select amount and confirm.
//   New card   — no saved payment method; fill the Stripe card form then confirm.

const DEFAULT_TIMEOUT = 15000;

async function navigateToBilling(page, billingUrl) {
  await page.goto(billingUrl, { waitUntil: "load" }).catch(() => {});
  if (!page.url() || page.url() === "about:blank") {
    throw new Error(`Navigation to ${billingUrl} failed — page is blank. Check network connectivity.`);
  }
}

async function run(page, provider, card, { dryRun }) {
  await navigateToBilling(page, provider.billing_url);

  const currentUrl = page.url();
  if (currentUrl.includes("/login") || currentUrl.includes("/auth") || !currentUrl.includes("platform.claude.com")) {
    console.log(`\nNot logged in to Anthropic (landed on: ${currentUrl})`);
    console.log("Please log in in the browser window. The script will continue once you reach the billing page.");
    await page.waitForURL("**/settings/**", { timeout: 120000 });
    await page.waitForLoadState("load");
  }

  if (!page.url().includes("billing")) {
    await navigateToBilling(page, provider.billing_url);
  }

  console.log("On billing page. Opening buy-credits modal...");

  const addCreditsBtn = page
    .getByRole("button", { name: /buy credits|add credits|purchase credits/i })
    .first();
  await addCreditsBtn.waitFor({ timeout: DEFAULT_TIMEOUT });
  await addCreditsBtn.click();

  // Amount selection — tiles show "$5", "$20", "$100" (no decimals)
  console.log("Selecting top-up amount...");
  const amountInt = Math.round(provider.suggested_topup_amount_usd);
  const amountLabel = `$${amountInt}`;
  const presetTile = page.getByRole("button", { name: amountLabel, exact: true }).first();
  const presetVisible = await presetTile.isVisible({ timeout: 3000 }).catch(() => false);

  if (presetVisible) {
    await presetTile.click();
  } else {
    const customInput = page
      .getByRole("spinbutton")
      .or(page.locator('input[type="number"]'))
      .first();
    await customInput.waitFor({ timeout: DEFAULT_TIMEOUT });
    await customInput.fill(String(provider.suggested_topup_amount_usd));
  }

  // Detect whether a Stripe payment iframe is present (new-card flow) or not (saved-card flow)
  const stripeFramePresent = await page
    .locator('iframe[name^="__privateStripeFrame"], iframe[title*="Secure payment" i], iframe[title*="card number" i]')
    .first()
    .isVisible({ timeout: 4000 })
    .catch(() => false);

  if (stripeFramePresent) {
    console.log("No saved card — filling card details...");
    await fillStripeElements(page, card);
  } else {
    console.log("Saved card detected — skipping card form.");
  }

  if (dryRun) {
    console.log("DRY RUN: skipping submit.");
    return;
  }

  // Submit button: "Buy $5 of credits", "Buy $20 of credits", etc.
  const submitBtn = page
    .getByRole("button", { name: /buy \$\d+ of credits/i })
    .first();
  await submitBtn.waitFor({ timeout: DEFAULT_TIMEOUT });
  await submitBtn.click();

  // Success: Anthropic shows a "Processing purchase…" spinner overlay, then the
  // modal closes and the billing page reflects the new balance.
  // Wait for the processing overlay to appear, then wait for it (and the modal) to close.
  const processingText = page.getByText(/processing/i);
  await processingText.waitFor({ timeout: 10000 }).catch(() => {});
  await page.locator('[role="dialog"]').waitFor({ state: "hidden", timeout: 30000 });

  console.log("Anthropic credit top-up confirmed.");
}

async function fillStripeElements(page, card) {
  const expiry = `${String(card.exp_month).padStart(2, "0")}/${String(card.exp_year).slice(-2)}`;

  const unifiedFrame = page
    .frameLocator('iframe[name^="__privateStripeFrame"], iframe[title*="Secure payment" i]')
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
    await numberInput.waitFor({ timeout: DEFAULT_TIMEOUT });
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

module.exports = { run };
