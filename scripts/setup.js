#!/usr/bin/env node
/**
 * Agent Keychain setup wizard.
 * Run: npm run setup
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

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

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// ── helpers ───────────────────────────────────────────────────────────────────

function nodeVersion() {
  const [major] = process.versions.node.split(".").map(Number);
  return major;
}

function run(cmd, { silent = false, cwd } = {}) {
  return spawnSync(cmd, { shell: true, encoding: "utf8", stdio: silent ? "pipe" : "inherit", cwd });
}

function mergeJson(filePath, patch) {
  let obj = {};
  if (fs.existsSync(filePath)) {
    try {
      obj = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) {
      throw new Error(`Cannot parse existing config at ${filePath}: ${e.message}\nFix or delete it before running setup.`);
    }
  }
  // Deep-merge top level + mcpServers
  const merged = { ...obj, ...patch };
  if (patch.mcpServers) {
    merged.mcpServers = { ...(obj.mcpServers || {}), ...patch.mcpServers };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n");
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
  const nodeModulesOk = fs.existsSync(path.join(pkgDir, "node_modules", "playwright"));
  if (nodeModulesOk) {
    console.log(`  ${ok} Already installed — skipping npm install`);
  } else {
    const r = run("npm install", { cwd: pkgDir });
    if (r.status !== 0) { console.error(`\n${fail} npm install failed.`); process.exit(1); }
    console.log(`  ${ok} Dependencies installed`);
  }

  // ── Step 2: Playwright Chromium ────────────────────────────────────────────
  step(2, TOTAL, "Installing Playwright Chromium browser…");
  // Cross-platform Chromium cache paths
  const playwrightCaches = [
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),  // macOS
    path.join(os.homedir(), ".cache", "ms-playwright"),              // Linux
    path.join(os.homedir(), "AppData", "Local", "ms-playwright"),    // Windows
  ];
  const hasChromium = playwrightCaches.some(
    dir => fs.existsSync(dir) && fs.readdirSync(dir).some(d => d.startsWith("chromium"))
  );

  if (hasChromium) {
    console.log(`  ${ok} Chromium already installed — skipping`);
  } else {
    console.log(`  ${info} Downloading Chromium (one-time, ~130 MB)…`);
    const r = run("npx playwright install chromium", { cwd: pkgDir });
    if (r.status !== 0) { console.error(`\n${fail} Playwright install failed.`); process.exit(1); }
    console.log(`  ${ok} Chromium installed`);
  }

  // ── Step 3: Stripe Link auth ───────────────────────────────────────────────
  step(3, TOTAL, "Authenticating with Stripe Link…");
  // Check if already authenticated by running a fast command
  const authCheck = run("npx @stripe/link-cli auth status", { silent: true });
  const alreadyAuthed = authCheck.status === 0 && authCheck.stdout.includes("authenticated: true");

  if (alreadyAuthed) {
    console.log(`  ${ok} Already authenticated with Stripe Link`);
  } else {
    console.log(`  ${info} Opening browser for Stripe Link authentication…`);
    console.log(`  ${c.dim}(Create a free account at link.stripe.com if you don't have one)${c.reset}`);
    const r = run("npx @stripe/link-cli auth login --client-name \"Agent Keychain\"", { cwd: pkgDir });
    if (r.status !== 0) {
      console.error(`\n${fail} Authentication failed. Run manually:\n  npx @stripe/link-cli auth login --client-name "Agent Keychain"`);
      process.exit(1);
    }
    console.log(`  ${ok} Authenticated`);
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

  // ── Step 5: MCP config ─────────────────────────────────────────────────────
  step(5, TOTAL, "Wiring up MCP server in Claude Code…");

  const globalConfig  = path.join(os.homedir(), ".claude", "claude_desktop_config.json");
  const projectConfig = path.join(process.cwd(), ".claude", "mcp.json");

  console.log(`  ${info} Where should the link-cli MCP server be registered?\n`);
  console.log(`    ${c.bold}1${c.reset}  Global  — available in every Claude Code project`);
  console.log(`       ${c.dim}${globalConfig}${c.reset}`);
  console.log(`    ${c.bold}2${c.reset}  Project — only this directory`);
  console.log(`       ${c.dim}${projectConfig}${c.reset}`);
  console.log(`    ${c.bold}3${c.reset}  Both`);

  const choice = await ask("\n  Enter 1, 2, or 3 [default: 1]: ");
  const scope = ["2", "3"].includes(choice) ? choice : "1";

  const patch = {
    mcpServers: {
      "link-cli": {
        command: "npx",
        args: ["@stripe/link-cli", "--mcp"],
        description: "Stripe Link — spend requests and virtual card issuance for Agent Keychain",
      },
    },
  };

  if (scope === "1" || scope === "3") {
    mergeJson(globalConfig, patch);
    console.log(`  ${ok} Written to ${globalConfig}`);
  }
  if (scope === "2" || scope === "3") {
    mergeJson(projectConfig, patch);
    console.log(`  ${ok} Written to ${projectConfig}`);
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  const skillSrc  = path.join(__dirname, "..", "skills", "topup", "SKILL.md");
  const skillDest = path.join(process.cwd(), ".claude", "skills", "topup", "SKILL.md");
  const runningFromRepo = path.resolve(process.cwd()) === path.resolve(pkgDir);

  console.log(`\n${c.bold}${c.green}Setup complete!${c.reset}\n`);
  console.log(`${c.bold}Next steps:${c.reset}`);
  console.log(`  ${info} Restart Claude Code (or run /mcp to reload servers)`);

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
})();
