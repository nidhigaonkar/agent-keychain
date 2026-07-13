# Agent Keychain

A Claude Code plugin that lets a coding agent top up its own API credits when
it runs low — using Stripe's Link wallet via the official `link-cli` MCP server.

No Stripe account. No API keys. No payment infrastructure to run.
The agent detects a quota error, requests a virtual card, you approve it in
the Stripe Link app, and the agent hands you the card to paste into the billing
page. One approval tap, credits restored, coding resumes.

---

## How it works

1. The agent hits a quota or credit error from a provider (OpenAI, Anthropic, v0).
2. It reads `providers.json` to identify the provider and billing URL.
3. It calls `link-cli`'s `spend-request create` MCP tool with a plain-English
   description of what's being purchased.
4. You get a push notification in the Stripe Link app — review the context
   string and tap Approve.
5. The agent receives a one-time virtual card saved to a local file (never
   printed to the terminal).
6. The agent tells you: "card is at `<path>`, top up at `<billing_url>`".
7. You paste the card, complete the top-up, tell the agent it's done.
8. The agent logs the transaction locally and deletes the card file.

The agent never touches the checkout form itself — that's a deliberate v0
constraint. See the roadmap below.

---

## Why Stripe Link instead of building payment infra?

Building a backend that stores card details, calls Stripe's API, and handles
PCI compliance is a month of work and an ongoing ops burden. Link inverts this:
Stripe holds the wallet, `link-cli` handles the spend-request and card
issuance, and we just write the skill layer that knows which providers exist
and what to say in the approval context. The human stays in the loop for every
dollar spent — by design.

---

## Setup (two steps)

### Step 1 — Authenticate link-cli

```bash
npx @stripe/link-cli auth login --client-name "Agent Keychain"
```

This opens a browser, you log in with your Stripe Link account (or create a
free one), and the CLI stores a local token. No Stripe developer account or
API key needed.

### Step 2 — Add the MCP server to Claude Code

Open your Claude Code MCP config (usually `~/.claude/claude_desktop_config.json`
or `.claude/settings.json` in your project) and merge in the block from
`mcp-config.json`:

```json
{
  "mcpServers": {
    "link-cli": {
      "command": "npx",
      "args": ["@stripe/link-cli", "mcp"]
    }
  }
}
```

Restart Claude Code. The `link_spend_request_*` tools will now be available
to the agent.

---

## Supported providers

| Provider | Auto-reload native? | Notes |
|---|---|---|
| OpenAI | Yes | Prefer enabling OpenAI's own auto-reload first |
| Anthropic | Yes | Prefer enabling Anthropic's own auto-reload first |
| v0 (Vercel AI) | No | Billing URL contains your username slug — see providers.json |

To add a provider, append an entry to `providers.json` following the existing
schema.

---

## Viewing the audit log

```bash
npm run view-log
```

Logs live at `~/.agent-keychain/audit-log.json`. They contain provider name,
amount, timestamp, context string, and spend-request ID. No card data is ever
written to the log.

---

## Security notes

- Card numbers and CVCs are written only to a short-lived local file
  (`--output-file`), never to stdout, logs, or the conversation.
- Every spend-request requires explicit human approval in the Stripe Link app.
  There is no way for the agent to auto-approve.
- Delete the card file after use — the agent does this automatically once you
  confirm the top-up.

---

## Roadmap

**v0 (current):** Manual card handoff. The agent gives you the card file path
and billing URL; you complete the form yourself.

**v1 (planned):** Per-provider browser automation in `scripts/checkout/`. Each
provider gets a script that opens the billing page, fills the card form, and
confirms the purchase — no human keystrokes needed. This will be added
provider-by-provider once the page structure is stable.
