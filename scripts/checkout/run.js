#!/usr/bin/env node
// Usage:
//   node scripts/checkout/run.js --provider <name> [--dry-run] [--new-card]
//   node scripts/checkout/run.js --provider <name> --finalize --confirm '<json>'
//
// Checkout via Browser Use Cloud with native Stripe Link (recommended):
//   https://browser-use.com/posts/pay-with-link
// Connect Link at cloud.browser-use.com → Integrations first.
//
// When the native-Link checkout would charge an already-saved default
// payment method with no separate card-entry step (no Link approval of any
// kind involved), the run always stops before the finalize click and prints
// a `READY_TO_FINALIZE: {...}` block instead. A human must approve those
// exact details before re-running with --finalize --confirm '<that json>' to
// actually charge anything. See scripts/checkout/tasks.js and the incident
// in logs/incidents/2026-09-24-anthropic-unconfirmed-charge.md.
//
// Legacy fallback (--spend-request-id): pre-approved link-cli virtual card via
// secret bindings — unreliable on Stripe iframes; prefer native Link.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const { BrowserUse } = require("browser-use-sdk/v4");
const { buildTask, buildSecretBindings } = require("./tasks");
const { loadEnvFile, repoEnvPath } = require("../lib/env");
const {
  resolveStripeLinkConnectionId,
  fetchStripeLinkStatus,
  watchRunForApproval,
  waitForLiveViewUrl,
} = require("../lib/browser-use");
const { preflightSpendRequest } = require("../lib/link-preflight");

const PROVIDERS_FILE = path.join(__dirname, "..", "..", "providers.json");
const LINK_CONNECT_URL = "https://cloud.browser-use.com";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      args[key] = val;
    }
  }
  return args;
}

function usage() {
  console.error(`
Usage:
  node scripts/checkout/run.js --provider <name> [--dry-run] [--new-card]
  node scripts/checkout/run.js --provider <name> --finalize --confirm '<json>'

Native Stripe Link (recommended):
  Connect Link at ${LINK_CONNECT_URL} → Integrations, then run checkout.
  Approve each purchase via the link printed in this terminal (one click).

If the run prints READY_TO_FINALIZE instead of completing, nothing was
charged — get explicit human approval for those exact details, then re-run
with --finalize --confirm '<the printed json>' to complete the purchase.

Legacy fallback (Stripe iframe issues):
  node scripts/checkout/run.js --provider <name> --spend-request-id <id>

Requires BROWSER_USE_API_KEY in .env.
`);
  process.exit(1);
}

function normalizeCardPayload(raw) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (Array.isArray(parsed)) {
    return parsed.find((entry) => entry?.card?.number) || parsed[parsed.length - 1];
  }
  return parsed;
}

function fetchCardFromSpendRequest(spendRequestId) {
  const tmpFile = path.join(os.tmpdir(), `keychain-card-${process.pid}-${Date.now()}.json`);
  try {
    const result = spawnSync(
      "npx",
      [
        "@stripe/link-cli",
        "spend-request",
        "retrieve",
        spendRequestId,
        "--include",
        "card",
        "--force",
        "--format",
        "json",
        "--output-file",
        tmpFile,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, NPM_CONFIG_LOGLEVEL: "error" },
      }
    );

    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim();
      throw new Error(detail || "link-cli spend-request retrieve failed");
    }
    if (!fs.existsSync(tmpFile)) {
      throw new Error("link-cli did not write card credentials to the temp output file");
    }

    return normalizeCardPayload(fs.readFileSync(tmpFile, "utf8"));
  } finally {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {}
  }
}

async function main() {
  loadEnvFile(repoEnvPath(path.join(__dirname, "..", "..")));

  const args = parseArgs(process.argv);

  if (!args.provider) {
    console.error("Missing required argument: --provider");
    usage();
  }

  if (!process.env.BROWSER_USE_API_KEY) {
    console.error(
      "BROWSER_USE_API_KEY is not set.\n" +
      "Add it to .env (see .env.example). Get a key at:\n" +
      "https://cloud.browser-use.com/settings?tab=api-keys"
    );
    process.exit(1);
  }

  const registry = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
  const provider = registry.providers.find(
    (p) => p.name.toLowerCase() === args.provider.toLowerCase()
  );
  if (!provider) {
    console.error(`Unknown provider: ${args.provider}. Check providers.json.`);
    process.exit(1);
  }

  const placeholderRe = /\{\{(\w+)\}\}/;
  if (typeof provider.billing_url === "string" && placeholderRe.test(provider.billing_url)) {
    console.error(
      `Provider "${provider.name}" has an unresolved placeholder in billing_url: ${provider.billing_url}\n` +
      "Run \`npm run setup\` again or edit providers.json."
    );
    process.exit(1);
  }

  const dryRun = !!args["dry-run"];
  const newCard = !!args["new-card"];
  const finalize = !!args["finalize"];
  let spendRequestId = args["spend-request-id"];
  let usePreflightCard = false;

  if (finalize && dryRun) {
    console.error("--finalize cannot be combined with --dry-run.");
    process.exit(1);
  }

  let confirmDetails = null;
  if (finalize) {
    if (!args.confirm) {
      console.error(
        "--finalize requires --confirm '<json>' — the READY_TO_FINALIZE block printed\n" +
        "by a prior run of this command without --finalize."
      );
      process.exit(1);
    }
    try {
      confirmDetails = JSON.parse(args.confirm);
    } catch (e) {
      console.error(`--confirm is not valid JSON: ${e.message}`);
      process.exit(1);
    }
    if (!confirmDetails.buttonText || confirmDetails.totalUsd == null) {
      console.error('--confirm JSON must include "buttonText" and "totalUsd".');
      process.exit(1);
    }
  }

  let stripeLinkConnectionId = null;
  try {
    stripeLinkConnectionId = await resolveStripeLinkConnectionId(process.env.BROWSER_USE_API_KEY);
  } catch (e) {
    console.error(`Could not check Stripe Link status: ${e.message}`);
    process.exit(1);
  }

  const browserSettings = { proxyCountryCode: "us" };
  const profileId = provider.browser_use_profile_id || process.env.BROWSER_USE_PROFILE_ID;
  if (profileId) browserSettings.profileId = profileId;

  console.log(`Starting Browser Use checkout for ${provider.name}…`);
  console.log(`Billing URL: ${provider.billing_url}`);
  if (dryRun) console.log("DRY RUN — will not finalize payment.");
  if (newCard) console.log("NEW CARD — will not use saved payment methods on file.");

  // Real checkouts: create spend request locally so approval URL prints in this terminal.
  // One-time setup: link-cli auth login (same Link wallet as Browser Use Integrations).
  if (!dryRun && !spendRequestId && !args["skip-preflight"]) {
    const amountUsd = provider.suggested_topup_amount_usd;
    console.log(`\nStep 1/2 — Link approval for $${amountUsd} ${provider.merchant_name} top-up…`);
    try {
      const preflight = await preflightSpendRequest(provider, {
        test: amountUsd <= 5,
        onApprovalUrl(url, id) {
          console.log(
            `\n🔗 APPROVE THIS PAYMENT (click now):\n   ${url}\n\n` +
            `Spend request: ${id}\nWaiting for approval…`
          );
        },
      });
      spendRequestId = preflight.spendRequestId;
      usePreflightCard = true;
      console.log(`Approved — spend request ${spendRequestId}\n`);
    } catch (e) {
      if (e.isAuthError) {
        console.error(
          "\nlink-cli is not authenticated (one-time setup).\n" +
          '  npx @stripe/link-cli auth login --client-name "Agent Keychain"\n' +
          "Then re-run this command.\n"
        );
        process.exit(1);
      }
      console.error(`Preflight failed: ${e.message}`);
      process.exit(1);
    }
  }

  const useNativeLink =
    !!stripeLinkConnectionId && !args["legacy-card"] && !usePreflightCard && !spendRequestId;

  if (!useNativeLink && !spendRequestId && dryRun) {
    if (!stripeLinkConnectionId) {
      console.error(
        "Stripe Link is not connected to Browser Use.\n" +
        `Connect at ${LINK_CONNECT_URL} → Integrations, then retry.`
      );
      process.exit(1);
    }
  }

  const createBody = {
    task: buildTask(provider, { dryRun, newCard, useNativeLink, finalize, confirmDetails }),
    browserSettings,
  };
  if (process.env.BROWSER_USE_MODEL) createBody.model = process.env.BROWSER_USE_MODEL;

  if (useNativeLink) {
    createBody.stripeLinkConnectionId = stripeLinkConnectionId;
    const linkStatus = await fetchStripeLinkStatus(process.env.BROWSER_USE_API_KEY);
    console.log(`Stripe Link: connected (${linkStatus.linkEmail || "account linked"})`);
  }

  if (usePreflightCard || (spendRequestId && !useNativeLink)) {
    console.log("Step 2/2 — Browser Use checkout with approved virtual card…");
    let cardData;
    try {
      cardData = fetchCardFromSpendRequest(spendRequestId);
    } catch (e) {
      console.error(`Could not fetch card credentials: ${e.message}`);
      process.exit(1);
    }
    if (!cardData.card || !cardData.card.number) {
      console.error("Card credentials missing from spend-request response.");
      process.exit(1);
    }
    createBody.secretBindings = buildSecretBindings(cardData.card, provider);
  }

  if (!profileId) {
    console.log(
      "Note: no browser profile set — sync login cookies via\n" +
      "https://docs.browser-use.com/cloud/guides/profile-sync.md"
    );
  }

  const client = new BrowserUse();
  const created = await client.runs.create(createBody);
  console.log(`Browser Use run: ${created.id}`);
  if (created.eventsUrl) console.log(`Events: ${created.eventsUrl}`);

  waitForLiveViewUrl(process.env.BROWSER_USE_API_KEY, created.id).then((url) => {
    if (url) console.log(`Live browser view: ${url}`);
  });

  const timeoutMs = dryRun ? 600_000 : 900_000;
  console.log(`Waiting for run to finish (timeout ${Math.round(timeoutMs / 60_000)} min)…`);

  let approvalPrinted = false;
  const watcher = useNativeLink && !dryRun
    ? await watchRunForApproval(process.env.BROWSER_USE_API_KEY, created.id, {
        onApprovalNeeded({ type, url, spendRequestId: reqId }) {
          if (type === "approval_url" && url) {
            console.log(`\n🔗 Approve payment: ${url}\n`);
            approvalPrinted = true;
          } else if (!approvalPrinted) {
            console.log(
              `\n⏳ Link approval needed${reqId ? ` (${reqId})` : ""} — check the Link app.\n`
            );
            approvalPrinted = true;
          }
        },
      })
    : null;

  let result;
  try {
    result = await client.runs.waitForCompletion(created.id, {
      timeout: timeoutMs,
      interval: 3_000,
    });
  } finally {
    if (watcher) watcher.stop();
  }

  console.log(`Run status: ${result.status}`);
  if (result.result) console.log(`Agent report:\n${result.result}`);

  if (result.status !== "completed") {
    console.error(`Checkout did not complete successfully (status: ${result.status}).`);
    process.exit(1);
  }

  const reportText = result.result || "";

  if (!finalize) {
    const readyMatch = reportText.match(/READY_TO_FINALIZE:\s*(\{[\s\S]*\})/);
    const notReadyMatch = reportText.match(/NOT_READY:\s*(.+)/);

    if (readyMatch) {
      let details;
      try {
        details = JSON.parse(readyMatch[1]);
      } catch {
        console.error("Could not parse READY_TO_FINALIZE details from the agent's report — see above.");
        process.exit(1);
      }
      console.log(`\nReady to finalize — nothing has been charged yet.`);
      console.log(`  Button: "${details.buttonText}"`);
      console.log(`  Total: $${details.totalUsd}`);
      if (details.paymentMethod) console.log(`  Payment method: ${details.paymentMethod}`);
      if (dryRun) {
        console.log(`\nDRY RUN — stopping here.`);
        return;
      }
      console.log(
        `\nGet explicit human approval for this exact charge, then finalize with:\n` +
        `  node scripts/checkout/run.js --provider ${provider.name} --finalize --confirm '${JSON.stringify(details)}'\n`
      );
      return;
    }

    if (notReadyMatch) {
      console.log(`\nNot ready to finalize: ${notReadyMatch[1].trim()}`);
      return;
    }
  }

  console.log(`\nCheckout complete for ${provider.name}.`);
  if (result.id) {
    console.log(`Log this Browser Use run ID for audit: ${result.id}`);
    if (spendRequestId) console.log(`Spend request ID: ${spendRequestId}`);
  }
}

main().catch((err) => {
  console.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});
