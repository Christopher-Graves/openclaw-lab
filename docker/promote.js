#!/usr/bin/env node
/**
 * promote.js — Promote test workspace changes to production
 *
 * Usage:
 *   node docker/promote.js --agent <name>            Interactive diff + confirm
 *   node docker/promote.js --agent <name> --auto     Auto-promote all changes
 *   node docker/promote.js --agent <name> --dry-run  Show diffs without copying
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";

const LAB_ROOT = path.resolve(import.meta.dirname, "..");

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(LAB_ROOT, "lab.config.json"), "utf-8"));
}

function loadAgentConfig(agentName) {
  return JSON.parse(
    fs.readFileSync(path.join(LAB_ROOT, "agents", agentName, "agent.json"), "utf-8")
  );
}

function resolvePath(p) {
  const HOME = process.env.USERPROFILE || process.env.HOME;
  return p.replace(/^~/, HOME);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { agent: null, auto: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--agent": opts.agent = args[++i]; break;
      case "--auto": opts.auto = true; break;
      case "--dry-run": opts.dryRun = true; break;
    }
  }
  if (!opts.agent) {
    console.error("Usage: node docker/promote.js --agent <name> [--auto|--dry-run]");
    process.exit(1);
  }
  return opts;
}

function getContainerName(config, agentName) {
  const prefix = config.docker?.containerPrefix || "openclaw-lab";
  return `${prefix}-${agentName}`;
}

function pullFromContainer(containerName, stageDir) {
  try {
    execSync(
      `docker cp ${containerName}:/home/node/.openclaw/workspace/. "${stageDir.replace(/\\/g, "/")}"`,
      { stdio: "pipe" }
    );
  } catch {
    console.log("  Warning: could not pull files from container, using staged copies");
  }
}

function diffFiles(file1, file2) {
  try {
    execSync(`diff -u "${file1}" "${file2}" 2>/dev/null`, { encoding: "utf-8" });
    return null;
  } catch (err) {
    if (err.status === 1) return err.stdout;
    return null;
  }
}

function askUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main() {
  const opts = parseArgs();
  const config = loadConfig();
  const agentConfig = loadAgentConfig(opts.agent);
  const containerName = getContainerName(config, opts.agent);

  const prodDir = resolvePath(agentConfig.productionDir || config.openclaw.configDir + "/workspace");
  const stageDir = path.join(LAB_ROOT, ".lab-staging", opts.agent, "workspace");
  const scoresDir = path.join(LAB_ROOT, "agents", opts.agent, "scores", "history");

  const promotableFiles = agentConfig.workspaceFiles || [
    "SOUL.md", "AGENTS.md", "TOOLS.md", "MEMORY.md",
  ];

  console.log(`\n=== Promote Test → Production: ${agentConfig.displayName || opts.agent} ===\n`);

  fs.mkdirSync(stageDir, { recursive: true });
  pullFromContainer(containerName, stageDir);

  if (!fs.existsSync(stageDir)) {
    console.error(`Test workspace not found at ${stageDir}`);
    console.error("Run docker/setup.js --init first.");
    process.exit(1);
  }

  const diffs = [];

  for (const file of promotableFiles) {
    const testPath = path.join(stageDir, file);
    const prodPath = path.join(prodDir, file);

    if (!fs.existsSync(testPath)) continue;

    if (!fs.existsSync(prodPath)) {
      diffs.push({ file, type: "new", testPath, prodPath });
      console.log(`  [NEW]  ${file}`);
      continue;
    }

    const diff = diffFiles(prodPath, testPath);
    if (diff) {
      diffs.push({ file, type: "modified", diff, testPath, prodPath });
      console.log(`  [MOD]  ${file}`);
    } else {
      console.log(`  [OK]   ${file} (no changes)`);
    }
  }

  if (diffs.length === 0) {
    console.log("\n  No changes to promote. Test and production are in sync.");
    return;
  }

  console.log(`\n  ${diffs.length} file(s) with changes\n`);

  if (opts.dryRun) {
    for (const d of diffs) {
      console.log(`\n--- ${d.file} ---`);
      if (d.diff) console.log(d.diff);
      else console.log("  (new file)");
    }
    console.log("\n  Dry run complete. No files were changed.");
    return;
  }

  const promoted = [];

  for (const d of diffs) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`  File: ${d.file} (${d.type})`);
    console.log("─".repeat(60));

    if (d.diff) {
      const lines = d.diff.split("\n");
      const preview = lines.slice(0, 40).join("\n");
      console.log(preview);
      if (lines.length > 40) console.log(`  ... (${lines.length - 40} more lines)`);
    } else {
      const content = fs.readFileSync(d.testPath, "utf-8");
      console.log(content.slice(0, 500));
      if (content.length > 500) console.log("  ...");
    }

    if (opts.auto) {
      fs.copyFileSync(d.testPath, d.prodPath);
      promoted.push(d.file);
      console.log(`  → Promoted ${d.file}`);
    } else {
      const answer = await askUser(`\n  Promote ${d.file}? [y/N] `);
      if (answer === "y" || answer === "yes") {
        fs.copyFileSync(d.testPath, d.prodPath);
        promoted.push(d.file);
        console.log(`  → Promoted ${d.file}`);
      } else {
        console.log(`  → Skipped ${d.file}`);
      }
    }
  }

  if (promoted.length === 0) {
    console.log("\n  No files promoted.");
    return;
  }

  fs.mkdirSync(scoresDir, { recursive: true });
  const logEntry = {
    timestamp: new Date().toISOString(),
    agent: opts.agent,
    promoted,
    total_changed: diffs.length,
  };
  const logFile = path.join(scoresDir, `promotion-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(logFile, JSON.stringify(logEntry, null, 2));

  console.log(`\n  ${promoted.length} file(s) promoted to production.`);
  console.log(`  Promotion logged to ${logFile}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
