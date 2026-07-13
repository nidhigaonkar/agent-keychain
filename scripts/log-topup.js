#!/usr/bin/env node
// Appends a top-up record to the local audit log.
// Card data (numbers, CVCs, expiry) must NEVER be passed to this script.

const fs = require("fs");
const path = require("path");
const os = require("os");

const LOG_DIR = path.join(os.homedir(), ".agent-keychain");
const LOG_FILE = path.join(LOG_DIR, "audit-log.json");

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
Usage: node log-topup.js \\
  --provider <name> \\
  --amount <dollars> \\
  --currency <usd> \\
  --spend-request-id <id> \\
  --context <string>

WARNING: Do NOT pass card numbers, CVCs, or expiry dates.
`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv);

  const required = ["provider", "amount", "currency", "spend-request-id", "context"];
  const missing = required.filter((k) => !args[k]);
  if (missing.length) {
    console.error(`Missing required arguments: ${missing.join(", ")}`);
    usage();
  }

  // Sanity check: refuse anything that looks like a card number.
  // (A bare 3-4 digit CVC isn't distinguishable from ordinary numbers like a
  // year or dollar amount, so we only guard against actual card-number-length
  // digit runs here — card data should never reach this script in the first
  // place per SKILL.md step 4.)
  const suspicious = /\b\d{13,19}\b/;
  if (suspicious.test(args.context)) {
    console.error("ERROR: context contains what looks like a card number. Aborting.");
    process.exit(1);
  }

  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  let log = [];
  if (fs.existsSync(LOG_FILE)) {
    try {
      log = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
    } catch {
      console.error("Warning: could not parse existing log — starting fresh.");
    }
  }

  const entry = {
    id: `topup_${Date.now()}`,
    timestamp: new Date().toISOString(),
    provider: args["provider"],
    amount_usd: parseFloat(args["amount"]),
    currency: args["currency"] || "usd",
    spend_request_id: args["spend-request-id"],
    context: args["context"],
  };

  log.push(entry);
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));

  console.log(`Logged top-up: ${entry.provider} $${entry.amount_usd} [${entry.spend_request_id}]`);
  console.log(`Log file: ${LOG_FILE}`);
}

main();
