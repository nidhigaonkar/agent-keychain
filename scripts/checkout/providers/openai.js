// OpenAI billing checkout automation.
// Navigates to platform.openai.com/settings/organization/billing/overview,
// clicks "Add to credit balance", fills amount + Stripe card form, submits.

const DEFAULT_TIMEOUT = 15000;

async function run(page, provider, card, { dryRun }) {
  await page.goto(provider.billing_url, { waitUntil: "networkidle" });

  const currentUrl = page.url();
  if (currentUrl.includes("/auth") || currentUrl.includes("/login") || !currentUrl.includes("platform.openai.com")) {
    console.log(`\nNot logged in to OpenAI (landed on: ${currentUrl})`);
    console.log("Please log in in the browser window. The script will continue automatically once you reach the billing page.");
    await page.waitForURL("**/settings/**", { timeout: 120000 });
    await page.waitForLoadState("networkidle");
  }

  if (!page.url().includes("billing")) {
    await page.goto(provider.billing_url, { waitUntil: "networkidle" });
  }

  console.log("On billing page. Looking for credit top-up button...");

  // OpenAI shows "Add to credit balance" button on the overview page
  const addCreditsBtn = page.getByRole("button", { name: /add to credit balance/i });
  await addCreditsBtn.waitFor({ timeout: DEFAULT_TIMEOUT });
  await addCreditsBtn.click();

  // A modal or inline form appears with an amount input
  console.log("Entering top-up amount...");
  const amountInput = page.getByRole("spinbutton").or(page.locator('input[type="number"]')).first();
  await amountInput.waitFor({ timeout: DEFAULT_TIMEOUT });
  await amountInput.fill(String(provider.suggested_topup_amount_usd));

  // OpenAI uses Stripe Elements — the card form lives in an iframe
  console.log("Filling card details...");
  await fillStripeElements(page, card);

  if (dryRun) {
    console.log("DRY RUN: skipping submit.");
    return;
  }

  // Submit button varies: "Add credits", "Confirm", "Pay"
  const submitBtn = page
    .getByRole("button", { name: /add credits|confirm|pay now|submit/i })
    .last();
  await submitBtn.waitFor({ timeout: DEFAULT_TIMEOUT });
  await submitBtn.click();

  // Wait for success indicator
  await page
    .getByText(/credit balance updated|payment successful|successfully added/i)
    .waitFor({ timeout: 30000 });

  console.log("OpenAI credit top-up confirmed.");
}

// Fills a standard Stripe Elements card form embedded in the page as iframes.
// Works for both the legacy 3-field layout (number / expiry / cvc) and the
// unified Payment Element layout.
async function fillStripeElements(page, card) {
  // Try unified Payment Element first (newer integrations)
  const unifiedFrame = page.frameLocator('iframe[name^="__privateStripeFrame"]').first();

  // Fall back to individual element iframes (legacy)
  const numberFrame = page
    .frameLocator('iframe[title*="card number" i], iframe[name*="__privateStripeFrame"]')
    .first();

  // Detect which layout we have
  const isUnified = await unifiedFrame
    .locator('[placeholder*="1234"]')
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  const expiry = `${String(card.exp_month).padStart(2, "0")}/${String(card.exp_year).slice(-2)}`;

  if (isUnified) {
    await unifiedFrame.locator('[placeholder*="1234"]').fill(card.number);
    await unifiedFrame.locator('[placeholder*="MM / YY"]').fill(expiry);
    await unifiedFrame.locator('[placeholder*="CVC"]').fill(card.cvc);
  } else {
    // Legacy: each field in its own iframe
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

  // Fill billing ZIP if present outside the iframe
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
