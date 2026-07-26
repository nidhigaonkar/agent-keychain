#!/usr/bin/env node
// Main entry point for v1 checkout automation.
// Usage: node scripts/checkout/run.js --provider <name> --card-file <path> [--dry-run]
//
// Reads the card file, launches a headed Playwright browser with a persistent
// profile (so the user's provider session survives between runs), navigates to
// the provider's billing page, and fills the card form.
//
// Card data is read once into memory, the file is deleted immediately after a
// successful form fill. It is never logged, printed, or passed to subprocesses.
//
// Exit codes: 0 = success, 1 = failure (reason printed to stderr)

const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright");

const PROFILE_DIR = path.join(os.homedir(), ".agent-keychain", "browser-profile");
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
Usage: node scripts/checkout/run.js \\
  --provider <name>       e.g. "OpenAI", "Anthropic", "v0"
  --card-file <path>      path to the card JSON file from link-cli
  [--dry-run]             navigate and fill but do not submit

Card data is never logged or printed. The card file is deleted after success.
`);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.provider || !args["card-file"]) {
    console.error("Missing required arguments: --provider and --card-file");
    usage();
  }

  const cardFilePath = path.resolve(args["card-file"]);
  if (!fs.existsSync(cardFilePath)) {
    console.error(`Card file not found: ${cardFilePath}`);
    process.exit(1);
  }

  let cardData;
  try {
    cardData = JSON.parse(fs.readFileSync(cardFilePath, "utf8"));
  } catch (e) {
    console.error(`Could not parse card file: ${e.message}`);
    process.exit(1);
  }

  if (!cardData.card || !cardData.card.number) {
    console.error("Card file does not contain card credentials. Was it retrieved with --include card?");
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
  if (!provider.checkout_script) {
    console.error(`No checkout script registered for provider: ${provider.name}`);
    process.exit(1);
  }

  const checkoutModule = require(path.join(__dirname, "providers", provider.checkout_script));

  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
  }

  console.log(`Launching browser for ${provider.name}...`);
  console.log(`Browser profile: ${PROFILE_DIR}`);
  console.log(`Billing URL: ${provider.billing_url}`);
  if (args["dry-run"]) console.log("DRY RUN — form will not be submitted.");

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chrome",
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = await browser.newPage();

  try {
    await checkoutModule.run(page, provider, cardData.card, { dryRun: !!args["dry-run"] });
    console.log(`\nCheckout complete for ${provider.name}.`);

    if (!args["dry-run"]) {
      fs.unlinkSync(cardFilePath);
      console.log(`Card file deleted: ${cardFilePath}`);
    }
  } catch (err) {
    const screenshotPath = path.join(
      os.homedir(), ".agent-keychain", `checkout-error-${Date.now()}.png`
    );
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`Screenshot saved: ${screenshotPath}`);
    } catch {}
    console.error(`\nCheckout failed: ${err.message}`);
    await browser.close();
    process.exit(1);
  }

  await browser.close();
}

main().catch((err) => {
  console.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});
