// v0 (Vercel AI) billing checkout automation.
// Navigates to v0.app/{username}/settings/billing, initiates credit purchase,
// fills Stripe card form, submits.
//
// v0 has no native auto-reload, so this is the primary top-up path.

const DEFAULT_TIMEOUT = 15000;

async function run(page, provider, card, { dryRun }) {
  await page.goto(provider.billing_url, { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(1500);

  // Check where we landed after redirects settle
  const currentUrl = page.url();
  const onBilling = currentUrl.includes("v0.app") && currentUrl.includes("billing");

  if (!onBilling) {
    console.log(`\nNot logged in to v0 (landed on: ${currentUrl})`);
    console.log("Please log in in the browser window.");
    console.log("The script will continue automatically once you reach the billing settings page.");
    // Wait for the user to log in and land back on a v0 settings page
    await page.waitForURL((url) => url.href.includes("v0.app") && url.href.includes("settings"), { timeout: 120000 });
    // Then navigate to billing specifically
    await page.goto(provider.billing_url, { waitUntil: "load" }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  console.log("On v0 billing page. Looking for Add Card button...");

  // v0's credit flow: add a payment card which is then used for auto-recharge
  // or plan upgrades. There is no standalone "buy N credits" button.
  const addCardBtn = page.getByRole("button", { name: /add card/i }).first();
  await addCardBtn.waitFor({ timeout: DEFAULT_TIMEOUT });
  await addCardBtn.click();

  // The modal opens: Stripe Link saved cards at top, new card form below.
  // Fill the card form FIRST, then click "Add New Payment Method".
  await page.waitForTimeout(2000);

  // Stripe Elements card form
  console.log("Filling card details...");
  await fillStripeElements(page, card);

  if (dryRun) {
    console.log("DRY RUN: skipping submit.");
    return;
  }

  const submitBtn = page.getByRole("button", { name: /add new payment method/i }).first();
  await submitBtn.waitFor({ timeout: DEFAULT_TIMEOUT });
  await submitBtn.click();

  // Wait for the card to appear in the payment methods list or a success toast
  await page
    .getByText(/card added|payment method added|saved|success/i)
    .or(page.locator('[class*="toast"], [class*="success"]'))
    .first()
    .waitFor({ timeout: 30000 });

  console.log("v0 card added successfully.");
}

async function fillStripeElements(page, card) {
  const expiry = `${String(card.exp_month).padStart(2, "0")}/${String(card.exp_year).slice(-2)}`;

  // v0 uses Stripe's unified Payment Element inside "Secure payment input frame"
  const secureFrame = page.frameLocator('iframe[title="Secure payment input frame"]');
  const cardNumberInput = secureFrame.locator('[placeholder*="1234"]');
  await cardNumberInput.waitFor({ timeout: DEFAULT_TIMEOUT });
  await cardNumberInput.click();
  await cardNumberInput.fill(card.number);

  await secureFrame.locator('[placeholder*="MM / YY"], [placeholder*="MM/YY"]').click();
  await secureFrame.locator('[placeholder*="MM / YY"], [placeholder*="MM/YY"]').fill(expiry);

  await secureFrame.locator('[placeholder*="CVC"], [placeholder*="CVV"]').click();
  await secureFrame.locator('[placeholder*="CVC"], [placeholder*="CVV"]').fill(card.cvc);

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
