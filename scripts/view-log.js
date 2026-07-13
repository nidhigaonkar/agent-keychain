#!/usr/bin/env node
// Prints a summary table of the local audit log.

const fs = require("fs");
const path = require("path");
const os = require("os");

const LOG_FILE = path.join(os.homedir(), ".agent-keychain", "audit-log.json");

function main() {
  if (!fs.existsSync(LOG_FILE)) {
    console.log("No audit log found. No top-ups have been recorded yet.");
    console.log(`Expected location: ${LOG_FILE}`);
    return;
  }

  let log;
  try {
    log = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
  } catch (e) {
    console.error(`Could not read log: ${e.message}`);
    process.exit(1);
  }

  if (!log.length) {
    console.log("Audit log is empty.");
    return;
  }

  const col = { id: 12, ts: 24, provider: 12, amount: 10, reqId: 28 };
  const header =
    "ID".padEnd(col.id) +
    "Timestamp".padEnd(col.ts) +
    "Provider".padEnd(col.provider) +
    "Amount".padEnd(col.amount) +
    "Spend Request ID";
  const divider = "-".repeat(header.length + col.reqId);

  console.log(`\nAgent Keychain — Top-Up Audit Log`);
  console.log(`File: ${LOG_FILE}\n`);
  console.log(header);
  console.log(divider);

  let total = 0;
  for (const entry of log) {
    const shortId = entry.id.replace("topup_", "").slice(-8);
    const ts = entry.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z");
    const amount = `$${entry.amount_usd.toFixed(2)}`;
    console.log(
      shortId.padEnd(col.id) +
      ts.padEnd(col.ts) +
      (entry.provider || "").padEnd(col.provider) +
      amount.padEnd(col.amount) +
      (entry.spend_request_id || "")
    );
    total += entry.amount_usd || 0;
  }

  console.log(divider);
  console.log(`${log.length} top-up(s) | Total: $${total.toFixed(2)}\n`);
}

main();
