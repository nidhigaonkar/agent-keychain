#!/usr/bin/env node
/**
 * Agent Keychain setup wizard.
 * Run: npm run setup
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { loadEnvFile, repoEnvPath, upsertEnvVar } = require("./lib/env");
const { fetchStripeLinkStatus } = require("./lib/browser-use");

// ── ANSI colours ──────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
};
const ok   = `${c.green}✓${c.reset}`;
const warn = `${c.yellow}⚠${c.reset}`;
const fail = `${c.red}✗${c.reset}`;
const info = `${c.cyan}›${c.reset}`;

function step(n, total, msg) {
  process.stdout.write(`\n${c.bold}[${n}/${total}]${c.reset} ${msg}\n`);
}

// A single shared interface for the whole run. Creating a fresh
// readline.Interface per question drops buffered input when stdin is a
// non-TTY pipe (e.g. answers piped in via a script) — the first interface
// can read ahead and consume lines meant for later questions.
let rlInstance = null;
function getRl() {
  if (!rlInstance) {
    rlInstance = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return rlInstance;
}
function ask(question) {
  return new Promise(resolve => getRl().question(question, ans => resolve(ans.trim())));
}
function closeRl() {
  if (rlInstance) rlInstance.close();
}

// ── helpers ───────────────────────────────────────────────────────────────────

function nodeVersion() {
  const [major] = process.versions.node.split(".").map(Number);
  return major;
}

function run(cmd, { silent = false, cwd } = {}) {
  return spawnSync(cmd, { shell: true, encoding: "utf8", stdio: silent ? "pipe" : "inherit", cwd });
}

// ── main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n${c.bold}${c.cyan}Agent Keychain — setup wizard${c.reset}`);
  console.log(`${c.dim}Lets your coding agent top up its own API credits via Stripe Link.${c.reset}`);

  // ── Step 0: Node version ───────────────────────────────────────────────────
  const nodeMaj = nodeVersion();
  if (nodeMaj < 18) {
    console.error(`\n${fail} Node.js 18+ required (found ${process.version}). Please upgrade.`);
    process.exit(1);
  }

  const TOTAL = 5;

  // ── Step 1: npm install ────────────────────────────────────────────────────
  step(1, TOTAL, "Installing npm dependencies…");
  const pkgDir = path.join(__dirname, "..");
  const nodeModulesOk = fs.existsSync(path.join(pkgDir, "node_modules", "browser-use-sdk"));
  if (nodeModulesOk) {
    console.log(`  ${ok} Already installed — skipping npm install`);
  } else {
    const r = run("npm install", { cwd: pkgDir });
    if (r.status !== 0) { console.error(`\n${fail} npm install failed.`); process.exit(1); }
    console.log(`  ${ok} Dependencies installed`);
  }

  // ── Step 2: Browser Use API key ────────────────────────────────────────────
  step(2, TOTAL, "Configuring Browser Use Cloud API…");
  const envPath = repoEnvPath(pkgDir);
  loadEnvFile(envPath);

  if (process.env.BROWSER_USE_API_KEY) {
    console.log(`  ${ok} BROWSER_USE_API_KEY already set`);
  } else {
    console.log(`  ${info} Get an API key at https://cloud.browser-use.com/settings?tab=api-keys`);
    const apiKey = await ask("  Paste your Browser Use API key: ");
    if (!apiKey) {
      console.error(`\n${fail} Browser Use API key is required for checkout automation.`);
      process.exit(1);
    }
    upsertEnvVar(envPath, "BROWSER_USE_API_KEY", apiKey);
    process.env.BROWSER_USE_API_KEY = apiKey;
    console.log(`  ${ok} Saved to ${envPath}`);
  }

  const profileId = await ask("  Browser Use profile ID for synced logins (optional, press Enter to skip): ");
  if (profileId) {
    upsertEnvVar(envPath, "BROWSER_USE_PROFILE_ID", profileId);
    console.log(`  ${ok} Profile ID saved — see https://docs.browser-use.com/cloud/guides/profile-sync.md`);
  } else {
    console.log(`  ${warn} No profile ID — sync login cookies before checkout:`);
    console.log(`     ${c.dim}curl -fsSL https://browser-use.com/profile.sh | sh${c.reset}`);
  }

  try {
    const linkStatus = await fetchStripeLinkStatus(process.env.BROWSER_USE_API_KEY);
    if (linkStatus.isConnected && linkStatus.connectionId) {
      upsertEnvVar(envPath, "BROWSER_USE_STRIPE_LINK_CONNECTION_ID", linkStatus.connectionId);
      console.log(`  ${ok} Stripe Link connected (${linkStatus.linkEmail || linkStatus.connectionId})`);
    } else {
      console.log(`  ${warn} Stripe Link not connected to Browser Use yet.`);
      console.log(`     Open https://cloud.browser-use.com → Integrations → Connect Stripe Link`);
      console.log(`     ${c.dim}https://browser-use.com/posts/pay-with-link${c.reset}`);
    }
  } catch (e) {
    console.log(`  ${warn} Could not check Stripe Link status: ${e.message}`);
  }

  // ── Step 3: link-cli auth (one-time, for checkout approval links in terminal) ─
  step(3, TOTAL, "Authenticating link-cli (one-time, same Link wallet)…");
  const authCheck = run("npx @stripe/link-cli auth status", { silent: true });
  const alreadyAuthed = authCheck.status === 0 && authCheck.stdout.includes("authenticated: true");

  if (alreadyAuthed) {
    console.log(`  ${ok} link-cli already authenticated`);
  } else {
    console.log(`  ${info} Opening browser for Stripe Link login…`);
    console.log(`  ${c.dim}(Same wallet you connected in Browser Use Integrations)${c.reset}`);
    const r = run('npx @stripe/link-cli auth login --client-name "Agent Keychain"', { cwd: pkgDir });
    if (r.status !== 0) {
      console.error(`\n${fail} link-cli auth failed. Run manually:\n  npx @stripe/link-cli auth login --client-name "Agent Keychain"`);
      process.exit(1);
    }
    console.log(`  ${ok} link-cli authenticated`);
  }

  // ── Step 4: Fill in per-user provider placeholders ─────────────────────────
  step(4, TOTAL, "Customising providers.json…");

  const providersFile = path.join(pkgDir, "providers.json");
  const placeholderRe = /\{\{(\w+)\}\}/g;

  try {
    const registry = JSON.parse(fs.readFileSync(providersFile, "utf8"));
    let changed = false;

    // Only `billing_url` is meant to carry per-user setup-time placeholders.
    // `context_template` intentionally keeps a {{amount}} placeholder that the
    // agent fills in per-request at runtime — never touch that one here.
    const SETUP_TIME_FIELDS = ["billing_url"];

    for (const provider of registry.providers || []) {
      const placeholders = new Set();
      for (const field of SETUP_TIME_FIELDS) {
        const value = provider[field];
        if (typeof value !== "string") continue;
        for (const m of value.matchAll(placeholderRe)) placeholders.add(m[1]);
      }
      if (placeholders.size === 0) continue;

      console.log(`  ${info} ${provider.name} needs per-user info before its billing URL is usable.`);
      const answers = {};
      for (const key of placeholders) {
        const label = key.replace(/_/g, " ");
        const ans = await ask(`    Enter your ${label} for ${provider.name} (leave blank to skip ${provider.name} for now): `);
        if (ans) answers[key] = ans;
      }

      if (Object.keys(answers).length === 0) {
        console.log(`  ${warn} Skipped — ${provider.name}'s billing_url still has a {{placeholder}}. The checkout script will refuse to run until you fill it in (re-run \`npm run setup\` or edit providers.json).`);
        continue;
      }

      for (const field of SETUP_TIME_FIELDS) {
        if (typeof provider[field] !== "string") continue;
        provider[field] = provider[field].replace(placeholderRe, (full, key) => (key in answers ? answers[key] : full));
      }
      provider.billing_url_verified = false; // user-supplied — not verified by us
      changed = true;
      console.log(`  ${ok} ${provider.name} configured — verify ${provider.billing_url} looks right before relying on it.`);
    }

    if (changed) {
      fs.writeFileSync(providersFile, JSON.stringify(registry, null, 2) + "\n");
    } else {
      console.log(`  ${ok} No per-user placeholders left to fill in`);
    }
  } catch (e) {
    console.log(`  ${warn} Could not process providers.json: ${e.message}`);
  }

  // ── Step 5: Install skill ──────────────────────────────────────────────────
  step(5, TOTAL, "Installing top-up skill…");

  // ── Done ───────────────────────────────────────────────────────────────────
  const skillSrc  = path.join(__dirname, "..", "skills", "topup", "SKILL.md");
  const skillDest = path.join(process.cwd(), ".claude", "skills", "topup", "SKILL.md");
  const runningFromRepo = path.resolve(process.cwd()) === path.resolve(pkgDir);

  console.log(`\n${c.bold}${c.green}Setup complete!${c.reset}\n`);
  console.log(`${c.bold}Next steps:${c.reset}`);
  console.log(`  ${info} Restart Claude Code so the top-up skill is loaded`);
  if (!process.env.BROWSER_USE_STRIPE_LINK_CONNECTION_ID) {
    console.log(`  ${warn} Connect Stripe Link once: https://cloud.browser-use.com → Integrations`);
  }

  if (runningFromRepo) {
    console.log(`  ${warn} SKILL.md was NOT auto-copied — you ran setup from inside the agent-keychain repo.`);
    console.log(`     Copy it into each project where you want the top-up skill:`);
    console.log(`     ${c.dim}mkdir -p /path/to/your/project/.claude/skills/topup && cp ${skillSrc} /path/to/your/project/.claude/skills/topup/SKILL.md${c.reset}`);
  } else if (fs.existsSync(skillDest)) {
    console.log(`  ${ok} SKILL.md already in place at ${skillDest}`);
  } else if (fs.existsSync(skillSrc)) {
    fs.mkdirSync(path.dirname(skillDest), { recursive: true });
    fs.copyFileSync(skillSrc, skillDest);
    console.log(`  ${ok} Copied SKILL.md → ${skillDest}`);
  } else {
    console.log(`  ${warn} Copy SKILL.md to your project's .claude/skills/topup/SKILL.md so the agent knows the top-up skill`);
  }
  console.log(`\n${c.dim}Audit log will be written to ~/.agent-keychain/audit-log.json${c.reset}\n`);
  closeRl();
})().catch(err => {
  console.error(`\n${fail} Setup failed: ${err.message}`);
  closeRl();
  process.exit(1);
});
