// Natural-language task prompts for Browser Use Cloud checkout runs.

const STRIPE_DOMAINS = ["js.stripe.com", "hooks.stripe.com"];

function providerDomains(provider) {
  try {
    const host = new URL(provider.billing_url).hostname;
    return [host, ...STRIPE_DOMAINS];
  } catch {
    return STRIPE_DOMAINS;
  }
}

// Wording shared by every "don't finalize" instruction below. Named loosely
// on purpose — merchant wording varies (e.g. "Buy $5 of credits" is a submit
// button, not a step to click through), and the model needs to recognize the
// pattern even when the exact label differs.
const FINALIZE_BUTTON_HINT =
  'a button labeled like "Buy $X of credits", "Purchase", "Pay now", "Confirm payment", "Place order", or "Submit payment" — or the primary/submit button in any checkout or "Add credits" dialog';

function finalizeGuardBlock() {
  return [
    `CRITICAL: never click ${FINALIZE_BUTTON_HINT} unless this task explicitly authorizes clicking that exact button (see below).`,
    "This applies even when a payment method is already saved and no separate card-entry step exists — a single-button \"Buy $X\" dialog IS the finalize step, not a step on the way to one.",
    "The instant you identify such a button, stop. Do not click it, and do not treat \"select the amount\" and \"finalize\" as the same click.",
  ].join("\n");
}

// Used for both --dry-run and the first ("identify") pass of a real run —
// in both cases the agent must stop before the click that would move money.
function identifyStopBlock() {
  return [
    finalizeGuardBlock(),
    "",
    "Instead of clicking it, make your FINAL message exactly one line in this format:",
    'READY_TO_FINALIZE: {"buttonText": "<exact visible text of the button that would finalize the charge>", "totalUsd": <number>, "paymentMethod": "<payment method that would be charged, e.g. \'Mastercard •••• 7515\'>"}',
    "If you cannot reach that point (login required, error, blocked, no such flow), report exactly: NOT_READY: <reason>",
  ].join("\n");
}

// Used for the second ("finalize") pass, only after a human has approved the
// exact button/amount from a prior identify pass.
function finalizeClickBlock(confirmDetails) {
  const { buttonText, totalUsd } = confirmDetails || {};
  return [
    "The user has already reviewed and approved this exact purchase:",
    `  Button: "${buttonText}"`,
    `  Total: $${totalUsd}`,
    "",
    "Reach that same point, VERIFY a button with exactly this text is present and the total shown matches, then click ONLY that button to finalize the purchase.",
    "If the button text or total shown does not match exactly, STOP and report a mismatch — do not click anything.",
    "After clicking, wait a few seconds, confirm the balance/confirmation state changed, and report the result clearly.",
  ].join("\n");
}

function dryRunBlock(dryRun) {
  if (dryRun) {
    return [
      "DRY RUN: fill the payment form completely but do NOT click purchase/submit/confirm.",
      `Treat ${FINALIZE_BUTTON_HINT} as a finalize action — the instant you identify it, stop without clicking it, even if it is the only visible next step.`,
      "Report what you reached and stop.",
    ].join("\n");
  }
  return "Complete the purchase and confirm success. Report clearly whether credits were added or the card was saved.";
}

function cardAliasesBlock() {
  return [
    "When a Stripe card form appears, fill it using these secret aliases (never type raw values):",
    "- card_number → card number field",
    "- card_exp → expiry field (MM/YY)",
    "- card_cvc → CVC/CVV field",
    "- card_zip → ZIP/postal code field (only if that field is visible)",
  ].join("\n");
}

// Native Stripe Link path. The Link-approval sub-flow (spend request created
// + approved via the Link app mid-run) already gets real human sign-off
// before any card is charged, so it keeps completing in one run. The only
// gap is the fallback sub-flow — a checkout with no separate card-entry step
// that would charge an already-saved default payment method directly, with
// no approval of any kind. That fallback always stops and requires a
// separate human-confirmed --finalize run (see run.js).
function linkPaymentBlock({ newCard, dryRun, finalize, confirmDetails } = {}) {
  const lines = [
    "PAYMENT — check this FIRST, before creating any Stripe Link spend request:",
    `If, after selecting the amount, there is NO separate card-entry step — the checkout would immediately charge an already-saved default payment method via a single button (e.g. "Buy $X of credits") — do NOT create a Stripe Link spend request for it, and do NOT click that button.`,
    finalize ? finalizeClickBlock(confirmDetails) : identifyStopBlock(),
    "",
    "Otherwise (a separate card-entry step exists), use the stripe-link skill (link-cli tools in this run) to request a one-time virtual card:",
    "- Do NOT look for a 'Pay with Link' button on the merchant page — many checkouts disable Link in the Stripe iframe.",
    "- Create a spend request for the checkout amount, then WAIT for user approval (poll up to 15 minutes — do not cancel early).",
    "- Tell the user approval is needed; they approve via the Browser Use run page approve button or the Link app.",
    "- After approval, fill the Stripe card fields with the issued virtual card.",
    "- Do NOT manually invent or type card numbers.",
  ];
  if (newCard) {
    lines.push(
      '- Do NOT use any saved payment method on file. Click "Add new payment method" or equivalent first.'
    );
  }
  lines.push(
    dryRun
      ? "- DRY RUN: navigate through checkout to the payment step and initiate Link if available, but do NOT approve or finalize the purchase. Report what you reached."
      : "- Complete the purchase after Link approval. Report clearly whether credits were added."
  );
  return lines.join("\n");
}

function buildAnthropicTask(provider, amount, { dryRun, newCard, useNativeLink, finalize, confirmDetails } = {}) {
  const amountInt = Math.round(amount);
  const paymentStep = useNativeLink
    ? linkPaymentBlock({ newCard, dryRun, finalize, confirmDetails })
    : newCard
      ? [
          "Do NOT use any saved payment method on file.",
          'Click "Add new payment method", "Use a different card", or equivalent to open the Stripe card form.',
          "Wait for the Stripe card form (iframe) to appear before filling.",
          cardAliasesBlock(),
          dryRunBlock(dryRun),
        ].join("\n\n")
      : [
          "If a saved payment method is already on file and no new card form appears, use the saved card and proceed.",
          cardAliasesBlock(),
          dryRunBlock(dryRun),
        ].join("\n\n");

  return [
    `Go to ${provider.billing_url}.`,
    "If you are not logged in (login page or redirect), stop immediately and report that login is required — do not attempt to log in.",
    'On the billing page, click "Buy credits" (or similar).',
    `Select the $${amountInt} top-up amount (preset tile or custom input).`,
    paymentStep,
  ].join("\n\n");
}

function buildOpenAITask(provider, amount, { dryRun, useNativeLink, finalize, confirmDetails } = {}) {
  return [
    `Go to ${provider.billing_url}.`,
    "If you are not logged in, stop immediately and report that login is required.",
    'Click "Add to credit balance" (or similar credit top-up button).',
    `Enter $${amount} as the top-up amount.`,
    useNativeLink
      ? linkPaymentBlock({ dryRun, finalize, confirmDetails })
      : [cardAliasesBlock(), dryRunBlock(dryRun)].join("\n\n"),
  ].join("\n\n");
}

function buildV0Task(provider, { dryRun, useNativeLink, finalize, confirmDetails } = {}) {
  return [
    `Go to ${provider.billing_url}.`,
    "If you are not logged in, stop immediately and report that login is required.",
    'v0 has no standalone "buy credits" button — click "Add Card" (or "Add new payment method") to register a payment method.',
    useNativeLink
      ? linkPaymentBlock({ newCard: true, dryRun, finalize, confirmDetails })
      : [cardAliasesBlock(), dryRun
          ? 'DRY RUN: fill the card form but DO NOT click "Add new payment method" / submit. Stop once filled.'
          : 'Submit to add the card. Confirm the payment method was saved successfully.',
        ].join("\n\n"),
  ].join("\n\n");
}

function buildTask(provider, { dryRun, newCard, useNativeLink, finalize, confirmDetails }) {
  const amount = provider.suggested_topup_amount_usd;
  const name = provider.name.toLowerCase();
  const opts = { newCard, useNativeLink, dryRun, finalize, confirmDetails };

  if (name === "anthropic") return buildAnthropicTask(provider, amount, opts);
  if (name === "openai") return buildOpenAITask(provider, amount, opts);
  if (name === "v0") return buildV0Task(provider, opts);

  throw new Error(`No Browser Use checkout task for provider: ${provider.name}`);
}

function buildSecretBindings(card, provider) {
  const domains = providerDomains(provider);
  const expiry = `${String(card.exp_month).padStart(2, "0")}/${String(card.exp_year).slice(-2)}`;

  const bindings = [
    {
      alias: "card_number",
      source: { type: "inline", value: card.number },
      allowedDomains: domains,
    },
    {
      alias: "card_exp",
      source: { type: "inline", value: expiry },
      allowedDomains: domains,
    },
    {
      alias: "card_cvc",
      source: { type: "inline", value: card.cvc },
      allowedDomains: domains,
    },
  ];

  if (card.billing_address?.postal_code) {
    bindings.push({
      alias: "card_zip",
      source: { type: "inline", value: card.billing_address.postal_code },
      allowedDomains: domains,
    });
  }

  return bindings;
}

module.exports = { buildTask, buildSecretBindings, providerDomains };
