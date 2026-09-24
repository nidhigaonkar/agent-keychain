# Agent Keychain

Agent Keychain lets a coding agent top up its own API credits via Stripe Link.

No Stripe developer account. No payment infrastructure to run.
The agent detects a quota error, runs checkout in the cloud, you approve once
in the Link app, and credits are restored.

---

## How it works

1. The agent hits a quota or credit error from a provider (OpenAI, Anthropic, v0).
2. It reads `providers.json` to identify the provider and billing URL.
3. It runs `node scripts/checkout/run.js --provider <name>`.
4. A [Browser Use](https://docs.browser-use.com/cloud/quickstart) cloud agent
   navigates the billing page (using your synced login profile).
5. At payment, your Link app prompts you to approve the exact amount — one tap.
   Link issues a one-time virtual card; the agent completes checkout.
6. The transaction is logged and the agent resumes coding.

**You only connect Stripe Link once** (during setup at
[cloud.browser-use.com → Integrations](https://cloud.browser-use.com)).
You do not create spend requests or click IDE approval links before each top-up.

---

## Setup (one command)

```bash
git clone https://github.com/nidhigaonkar/agent-keychain
cd agent-keychain
npm run setup
```

The setup wizard handles:

1. **npm install** — installs dependencies
2. **Browser Use** — API key, optional profile ID, verifies Stripe Link is connected
3. **Provider setup** — fills per-user placeholders (e.g. v0 billing URL username)
4. **Skill install** — copies the `topup` skill into `.claude/skills/topup/`

**One-time Link connection:** during setup, open
[cloud.browser-use.com → Integrations](https://cloud.browser-use.com) and
connect Stripe Link. You only do this once.

**Sync login cookies** so the cloud browser reaches billing pages while logged in:

```bash
export BROWSER_USE_API_KEY=your_key
curl -fsSL https://browser-use.com/profile.sh | sh
```

Set `BROWSER_USE_PROFILE_ID` in `.env`, then restart Claude Code.

---

## Supported providers

| Provider | Auto-reload native? | Notes |
|---|---|---|
| OpenAI | Yes | Prefer enabling OpenAI's own auto-reload first |
| Anthropic | Yes | Prefer enabling Anthropic's own auto-reload first |
| v0 (Vercel AI) | No | Billing URL contains your username slug — filled in by `npm run setup` |

To add a provider, append an entry to `providers.json` following the existing schema.

---

## Testing checkout

```bash
# Dry run — reaches payment step without charging
node scripts/checkout/run.js --provider Anthropic --new-card --dry-run

# Real top-up (approve in Link app when prompted)
node scripts/checkout/run.js --provider Anthropic --new-card
```

---

## Known limitations

- **Checkout uses Browser Use Cloud** — requires a Browser Use API key and credits.
- **Login state** must be synced to a Browser Use profile before checkout.
- Checkout is agent-driven — resilient to UI changes, but best-effort.
- Some merchant Stripe forms hide the Link wallet UI; Browser Use still handles
  payment via its built-in stripe-link integration at the payment step.

---

## Monitoring your balance

Agent Keychain triggers reactively — when the agent hits a credit error. Enable
native auto-reload where available:

- **Anthropic** — [platform.claude.com/settings/billing](https://platform.claude.com/settings/billing) → Auto reload
- **OpenAI** — [platform.openai.com/settings/organization/billing](https://platform.openai.com/settings/organization/billing) → Auto recharge

For **v0** (no native auto-reload), Agent Keychain is the primary solution.

---

## Viewing the audit log

```bash
npm run view-log
```

Logs live at `~/.agent-keychain/audit-log.json`. They contain provider name,
amount, timestamp, and Browser Use run ID. No card data is ever written.

---

## Security

- Every purchase requires explicit human approval in the Link app before money moves.
- Card data is never printed to the terminal, logs, or the conversation.
- Stripe Link connection is stored by Browser Use — not in this repo.
