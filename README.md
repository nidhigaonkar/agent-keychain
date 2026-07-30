# Agent Keychain


Agent Keychain lets a coding agent top up its own API credits via Stripe Link with one click approval in the IDE.

No API keys. No payment infrastructure to run.
The agent detects a quota error, creates a spend request, you approve it with
one click in your browser, and the agent completes the billing form automatically.
Credits restored, coding resumes.

---

## How it works

1. The agent hits a quota or credit error from a provider (OpenAI, Anthropic, v0).
2. It reads `providers.json` to identify the provider and billing URL.
3. It calls Stripe Link's `link-cli`'s `spend-request create` MCP tool with a plain-English
   description of what's being purchased.
4. The agent posts a clickable approval link directly in your IDE chat:
   **[Approve $5 for Anthropic](https://app.link.com/activity/approve/…)**
   You click it, review the context and amount in your browser, and approve.
5. A headed browser opens, navigates to the provider's billing page using your
   existing login session, and completes the purchase automatically.
6. The transaction is logged and the agent resumes coding.

---

## Setup (one command)

```bash
git clone https://github.com/nidhigaonkar/agent-keychain
cd agent-keychain
npm run setup
```

The setup wizard handles everything:

1. **npm install** — installs dependencies (skips if already done)
2. **Playwright Chromium** — downloads the browser used for checkout automation (~130 MB, one-time)
3. **Stripe Link auth** — opens a browser so you can log in (or create a free account at link.stripe.com — no Stripe developer account or API key needed)
4. **Provider setup** — fills in any per-user info a provider needs (e.g. v0's billing URL contains your personal username slug) so `providers.json` works for your account, not just the maintainer's
5. **MCP config** — merges the `link-cli` server into your Claude Code config (global or project-scoped, your choice) and copies the `topup` skill into `.claude/skills/topup/`

Then restart Claude Code (or run `/mcp`) and you're done.

---

## Supported providers

| Provider | Auto-reload native? | Notes |
|---|---|---|
| OpenAI | Yes | Prefer enabling OpenAI's own auto-reload first |
| Anthropic | Yes | Prefer enabling Anthropic's own auto-reload first |
| v0 (Vercel AI) | No | Billing URL contains your username slug — filled in by `npm run setup` |

To add a provider, append an entry to `providers.json` following the existing schema.

---

## Known limitations

- **Checkout automation is UI-selector-based** and will break if a provider
  changes its billing page layout. If a checkout script fails, it saves a
  screenshot to `~/.agent-keychain/checkout-error-<timestamp>.png` and falls
  back to a manual link — but treat the automated flow as best-effort, not
  guaranteed, especially for providers you haven't tested it against yourself.
- Only the Anthropic checkout flow has been verified end-to-end against the
  live billing page. OpenAI and v0 automation is implemented but less
  battle-tested — run with `--dry-run` first if you want to sanity-check the
  flow before it submits a real purchase.

---

## Monitoring your balance

Agent Keychain triggers reactively — when the agent hits a credit error. If
you want to stay ahead of that, enable native auto-reload on the providers
that support it:

- **Anthropic** — [platform.claude.com/settings/billing](https://platform.claude.com/settings/billing) → Auto reload
- **OpenAI** — [platform.openai.com/settings/organization/billing](https://platform.openai.com/settings/organization/billing) → Auto recharge

Set a low-balance threshold (e.g. reload $20 when balance drops below $5) and
your card on file handles it automatically — no agent involvement needed.

For **v0** (no native auto-reload), Agent Keychain is the primary solution.

---

## Viewing the audit log

```bash
npm run view-log
```

Logs live at `~/.agent-keychain/audit-log.json`. They contain provider name,
amount, timestamp, and spend-request ID. No card data is ever written to the log.

---

## Security

- Every spend-request requires explicit human approval before any money moves.
  There is no way for the agent to auto-approve.
- No credentials are stored by Agent Keychain. The Stripe Link auth token is
  managed entirely by `link-cli` in its own secure location.
- Card data is never printed to the terminal, logs, or the conversation.
