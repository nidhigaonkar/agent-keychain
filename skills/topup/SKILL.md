---
name: topup
description: >-
  Top up an API provider's (OpenAI, Anthropic, v0) credits via Browser Use +
  Stripe Link. Use when an agent's API calls fail with a quota, credit-balance,
  or billing error, or when the user explicitly asks to top up API credits.
---

# Agent Keychain — Top-Up Skill

You are an agent running inside a coding session. When a provider runs out of
credits, run automated checkout. The human only approves payment in the Link
app at checkout time — no separate spend-request step in the IDE.

**One-time setup (human does this once):**
1. `npm run setup` — Browser Use API key, profile ID, link-cli auth, connect Link at [cloud.browser-use.com → Integrations](https://cloud.browser-use.com)
2. Sync provider login cookies to Browser Use (profile sync guide)

After that, every top-up is: detect error → run checkout → click the approval link printed in the terminal (one click per purchase).

---

## 1. When to trigger this skill

Trigger when you encounter any of the following from a provider API:

| Signal | Examples |
|---|---|
| HTTP 402 or 429 with a billing message | `"insufficient credits"`, `"credit limit reached"` |
| Explicit quota/balance errors | `"You exceeded your current quota"`, `"credit balance too low"`, `"insufficient_quota"` |
| Auth errors that mention billing | `"billing_error"`, `"payment required"` |

Check `providers.json` (repo root) to match the error to a provider using
`error_patterns`.

**Do not trigger for time-based rate limits** (e.g. "retry after 60s") — only
when the error indicates a money/credit shortage.

---

## 2. Auto-reload check

Before topping up, check `has_native_auto_reload` in `providers.json`:

- If `true` (OpenAI, Anthropic): suggest enabling the provider's auto-reload
  and link the billing URL. Only proceed if auto-reload is already on and
  failed, or the human explicitly asks for a manual top-up.
- If `false` (v0): proceed directly to checkout.

---

## 3. Run checkout (primary flow)

The checkout script creates a spend request and **prints an approval link in the
terminal** — the human clicks it once per purchase. No separate IDE/MCP step.

Requires `BROWSER_USE_API_KEY` in `.env` and one-time link-cli auth from setup.

```bash
node scripts/checkout/run.js --provider "<provider name>"
```

Options:
- `--new-card` — add a new payment method instead of using a saved card
- `--dry-run` — navigate to payment step without charging (skips preflight)

Login cookies must be synced to a Browser Use profile (`BROWSER_USE_PROFILE_ID`
in `.env`). See https://docs.browser-use.com/cloud/guides/profile-sync.md

**Tell the human when checkout starts:**
> "Click the approval link in the terminal when it appears, then I'll finish checkout."

**Never print card numbers, CVCs, or expiry dates.**

Exit code 0 = success. Note the Browser Use run ID from stdout for audit.

On failure, fall back to manual handoff (section 5).

### 3a. `READY_TO_FINALIZE` — some checkouts require a second, explicit approval

Some providers' billing pages have no separate card-entry step — selecting an
amount and clicking the one visible button (e.g. "Buy $5 of credits") charges
an already-saved default payment method immediately, with no Link approval
involved at all. For that case the script above will **not** charge anything;
it stops and prints something like:

```
Ready to finalize — nothing has been charged yet.
  Button: "Buy $5 of credits"
  Total: $5
  Payment method: Mastercard •••• 7515

Get explicit human approval for this exact charge, then finalize with:
  node scripts/checkout/run.js --provider anthropic --finalize --confirm '{"buttonText":"Buy $5 of credits","totalUsd":5,"paymentMethod":"Mastercard •••• 7515"}'
```

You **must** show the human these exact details (button text, total,
payment method) and get an explicit yes before running the `--finalize`
command — do not run it on their behalf without asking first, and do not
paraphrase or round the amount. If they decline, stop; nothing has been
charged. Only log the top-up (section 4) after the `--finalize` run reports
success.

---

## 4. Log the top-up

After checkout succeeds (or the human confirms a manual top-up):

```bash
node scripts/log-topup.js \
  --provider "<provider name>" \
  --amount <dollars> \
  --currency usd \
  --browser-use-run-id "<run id from checkout stdout>" \
  --context "<brief description of why credits were needed>"
```

Use `--spend-request-id` only if you used the legacy checkout path.

---

## 5. Manual fallback

If automated checkout fails or Browser Use is not configured:

1. Tell the human the billing URL from `providers.json`:
   > "Automated checkout failed. Please go to `<billing_url>` and add credits.
   > Let me know when done."

2. Do not print card details. After confirmation, log with `--context` only
   (use `--browser-use-run-id` if you have one from a partial run).

---

## 6. Quick-reference flow

```
Error detected → match provider in providers.json
  ↓
has_native_auto_reload?
  YES → suggest auto-reload unless human overrides
  NO  → continue
  ↓
node scripts/checkout/run.js --provider "<name>" [--new-card]
  ↓
Human approves in Link app when prompted (once per purchase)
  ↓
success? → log-topup.js with --browser-use-run-id
fail?    → manual billing URL handoff → log after confirm
```

---

## Legacy: link-cli spend-request path (optional)

Only use if Browser Use / native Link is unavailable. Requires link-cli MCP and
a separate IDE approval link before checkout:

```bash
node scripts/checkout/run.js --provider "<name>" --spend-request-id "<id>" --legacy-card
```

This path is unreliable on Stripe iframes. Prefer the primary flow in section 3.
