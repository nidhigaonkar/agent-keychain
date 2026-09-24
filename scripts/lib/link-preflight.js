const { spawnSync } = require("child_process");

function runLinkCli(args) {
  const result = spawnSync("npx", ["@stripe/link-cli", ...args], {
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_LOGLEVEL: "error" },
  });
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  if (result.status !== 0) {
    const detail = stderr || stdout;
    const err = new Error(detail || "link-cli command failed");
    err.isAuthError = /not authenticated|refresh_token|auth login/i.test(detail);
    throw err;
  }
  return stdout;
}

function parseJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`link-cli returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  if (Array.isArray(parsed)) {
    return parsed.find((entry) => entry?.id) || parsed[parsed.length - 1];
  }
  return parsed;
}

function buildContext(provider, amountUsd) {
  return provider.context_template.replace("{{amount}}", String(amountUsd));
}

function createSpendRequest(provider, { test = false } = {}) {
  const amountUsd = provider.suggested_topup_amount_usd;
  const amountCents = Math.round(amountUsd * 100);
  const args = [
    "spend-request",
    "create",
    "--merchant-name",
    provider.merchant_name,
    "--merchant-url",
    provider.merchant_url,
    "--amount",
    String(amountCents),
    "--currency",
    "usd",
    "--context",
    buildContext(provider, amountUsd),
    "--format",
    "json",
  ];
  if (test) args.push("--test");

  return parseJson(runLinkCli(args));
}

function waitForApproval(spendRequestId, { intervalSec = 2, maxAttempts = 150 } = {}) {
  const stdout = runLinkCli([
    "spend-request",
    "retrieve",
    spendRequestId,
    "--interval",
    String(intervalSec),
    "--max-attempts",
    String(maxAttempts),
    "--format",
    "json",
  ]);
  return parseJson(stdout);
}

async function preflightSpendRequest(provider, { test = false, onApprovalUrl } = {}) {
  const created = createSpendRequest(provider, { test });
  const id = created.id;
  if (!id) throw new Error("link-cli did not return a spend-request id");

  if (created.approval_url) {
    onApprovalUrl?.(created.approval_url, id);
  } else if (created.status !== "approved") {
    console.log("Waiting for Link approval (check your Link app if no browser prompt)…");
  }

  const approved = created.status === "approved" ? created : waitForApproval(id);
  if (approved.status !== "approved") {
    throw new Error(`Spend request not approved (status: ${approved.status || "unknown"})`);
  }
  return { spendRequestId: id, approved };
}

module.exports = { preflightSpendRequest, createSpendRequest, waitForApproval };
