#!/usr/bin/env node
// Usage: node scripts/checkout/run.js --provider <name> [--dry-run]
//
// Card data is read from stdin as JSON — it never touches disk.
// Pipe the spend-request card response directly:
//   echo '<card-json>' | node scripts/checkout/run.js --provider Anthropic
//
// Exit codes: 0 = success, 1 = failure (reason printed to stderr)

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { chromium } = require("playwright");

const PROFILE_DIR    = path.join(os.homedir(), ".agent-keychain", "browser-profile");
const PROVIDERS_FILE = path.join(__dirname, "..", "..", "providers.json");

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
Usage: node scripts/checkout/run.js --provider <name> [--dry-run]

Card JSON is read from stdin:
  echo '<json>' | node scripts/checkout/run.js --provider Anthropic

The JSON must contain a top-level "card" object with number, exp_month,
exp_year, cvc, and billing_address fields (the format returned by link-cli
spend-request retrieve --include card).
`);
  process.exit(1);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.provider) {
    console.error("Missing required argument: --provider");
    usage();
  }

  const registry = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
  const provider  = registry.providers.find(
    p => p.name.toLowerCase() === args.provider.toLowerCase()
  );
  if (!provider) {
    console.error(`Unknown provider: ${args.provider}. Check providers.json.`);
    process.exit(1);
  }
  if (!provider.checkout_script) {
    console.error(`No checkout script registered for provider: ${provider.name}`);
    process.exit(1);
  }

  // Read card data from stdin — never written to disk by this script
  let cardData;
  try {
    const raw = await readStdin();
    cardData = JSON.parse(raw);
  } catch (e) {
    console.error(`Could not parse card JSON from stdin: ${e.message}`);
    process.exit(1);
  }

  if (!cardData.card || !cardData.card.number) {
    console.error("stdin JSON does not contain card credentials (expected a .card.number field).");
    process.exit(1);
  }

  const checkoutModule = require(path.join(__dirname, "providers", provider.checkout_script));

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log(`Launching browser for ${provider.name}...`);
  console.log(`Billing URL: ${provider.billing_url}`);
  if (args["dry-run"]) console.log("DRY RUN — form will not be submitted.");

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel:  "chrome",
    viewport: { width: 1280, height: 800 },
    args:     ["--disable-blink-features=AutomationControlled"],
  });

  const page = await browser.newPage();

  let checkoutOk = false;
  try {
    await checkoutModule.run(page, provider, cardData.card, { dryRun: !!args["dry-run"] });
    console.log(`\nCheckout complete for ${provider.name}.`);
    checkoutOk = true;
  } catch (err) {
    const screenshotPath = path.join(
      os.homedir(), ".agent-keychain", `checkout-error-${Date.now()}.png`
    );
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`Screenshot saved: ${screenshotPath}`);
    } catch {}
    console.error(`\nCheckout failed: ${err.message}`);
  } finally {
    await browser.close();
  }

  if (!checkoutOk) process.exit(1);
}

main().catch(err => {
  console.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});
