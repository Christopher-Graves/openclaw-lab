#!/usr/bin/env node
/**
 * cycle.js — Autonomous 5-phase test orchestrator
 *
 * Phases:
 *   1. Refresh test env from production (optional)
 *   2. Test all scenarios against Docker gateway
 *   3. Score workspace files against rubrics
 *   4. Fix failing scenarios (if --fix)
 *   5. Report results + Promote (if --promote)
 *
 * Usage:
 *   node tests/cycle.js --agent <name>                Run test + score + report
 *   node tests/cycle.js --agent <name> --refresh      Pull latest production files first
 *   node tests/cycle.js --agent <name> --fix          Auto-fix failures and re-test
 *   node tests/cycle.js --agent <name> --promote      Copy passing fixes to production
 *   node tests/cycle.js --agent <name> --max-budget 10
 *   node tests/cycle.js --agent <name> --model sonnet
 *   node tests/cycle.js --agent <name> --scenario DON-001
 *   node tests/cycle.js --agent <name> --file SOUL.md
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import {
  scoreAllFiles,
  reportDeltas,
  saveScores,
  loadPreviousScores,
} from "./scorer.js";

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

function getContainerName(config, agentName) {
  const prefix = config.docker?.containerPrefix || "openclaw-lab";
  return `${prefix}-${agentName}`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    agent: null,
    refresh: false,
    fix: false,
    promote: false,
    maxBudget: 20,
    model: "sonnet",
    scenario: null,
    file: null,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--agent": opts.agent = args[++i]; break;
      case "--refresh": opts.refresh = true; break;
      case "--fix": opts.fix = true; break;
      case "--promote": opts.promote = true; break;
      case "--max-budget": opts.maxBudget = parseFloat(args[++i]); break;
      case "--model": opts.model = args[++i]; break;
      case "--scenario": opts.scenario = args[++i]; break;
      case "--file": opts.file = args[++i]; break;
      case "--verbose": opts.verbose = true; break;
    }
  }

  if (!opts.agent) {
    console.error("Usage: node tests/cycle.js --agent <name> [options]");
    process.exit(1);
  }
  return opts;
}

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { encoding: "utf-8", timeout: 300000, ...opts });
}

function pullWorkspaceFromContainer(containerName, stageDir) {
  const stagePath = path.join(stageDir, "workspace").replace(/\\/g, "/");
  fs.mkdirSync(stagePath, { recursive: true });
  try {
    run(`docker cp ${containerName}:/home/node/.openclaw/workspace/. "${stagePath}"`);
  } catch {
    console.log("  Warning: could not pull workspace from container");
  }
}

function pushFileToContainer(containerName, stageDir, filename) {
  const localPath = path.join(stageDir, "workspace", filename).replace(/\\/g, "/");
  try {
    run(`docker cp "${localPath}" ${containerName}:/home/node/.openclaw/workspace/${filename}`);
  } catch {
    console.log(`  Warning: could not push ${filename} to container`);
  }
}

// ── Phase 1: Refresh ──

function phaseRefresh(agentName) {
  console.log("\n━━━ Phase 1: Refresh Test Environment ━━━\n");
  run(`node "${path.join(LAB_ROOT, "docker", "setup.js")}" --agent ${agentName} --refresh`);
}

// ── Phase 2: Test ──

async function phaseTest(opts) {
  console.log("\n━━━ Phase 2: Run Test Scenarios ━━━\n");

  const args = ["--agent", opts.agent, "--mode", "docker", "--verbose"];
  if (opts.scenario) args.push("--scenario", opts.scenario);

  try {
    const output = run(`node "${path.join(LAB_ROOT, "tests", "runner.js")}" ${args.join(" ")}`);
    console.log(output);
    return { success: true, output };
  } catch (err) {
    console.log(err.stdout || err.message);
    return { success: false, output: err.stdout || err.message };
  }
}

// ── Phase 3: Score ──

async function phaseScore(opts, containerName, stageDir) {
  console.log("\n━━━ Phase 3: Score Workspace Files ━━━\n");

  pullWorkspaceFromContainer(containerName, stageDir);

  const config = loadConfig();
  const workspaceDir = path.join(stageDir, "workspace");

  const scores = scoreAllFiles(opts.agent, workspaceDir, {
    file: opts.file,
    scoringModel: config.scoring?.model || "haiku",
  });

  const previous = loadPreviousScores(opts.agent);
  reportDeltas(scores, previous);

  const savedPath = saveScores(opts.agent, scores);
  console.log(`\n  Scores saved to ${savedPath}`);

  return scores;
}

// ── Phase 4: Fix ──

async function phaseFix(opts, containerName, stageDir) {
  console.log("\n━━━ Phase 4: Auto-Fix Failures ━━━\n");

  const resultsDir = path.join(LAB_ROOT, "agents", opts.agent, "results");
  if (!fs.existsSync(resultsDir)) {
    console.log("  No test results found to fix");
    return { fixed: 0, attempts: 0 };
  }

  const resultFiles = fs
    .readdirSync(resultsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  if (resultFiles.length === 0) {
    console.log("  No test results found to fix");
    return { fixed: 0, attempts: 0 };
  }

  const latestResults = JSON.parse(
    fs.readFileSync(path.join(resultsDir, resultFiles[0]), "utf-8")
  );

  const failures = latestResults.results.filter(
    (r) => r.verdict === "FAIL" || r.verdict === "ERROR"
  );

  if (failures.length === 0) {
    console.log("  All tests passed — nothing to fix!");
    return { fixed: 0, attempts: 0 };
  }

  console.log(`  ${failures.length} failure(s) to address\n`);

  pullWorkspaceFromContainer(containerName, stageDir);

  const agentConfig = loadAgentConfig(opts.agent);
  const agentName = agentConfig.displayName || agentConfig.name;
  let fixCount = 0;
  const modelFlag = opts.model === "opus" ? "opus" : "sonnet";

  for (const failure of failures) {
    console.log(`  Fixing ${failure.id}: ${failure.name}`);
    console.log(`    Failure: ${failure.llmScore?.reasoning || "pattern match"}`);

    const wsDir = path.join(stageDir, "workspace");
    const soulContent = readIfExists(path.join(wsDir, "SOUL.md"));
    const agentsContent = readIfExists(path.join(wsDir, "AGENTS.md"));

    const fixPrompt = `You are fixing a prompt engineering issue with an AI assistant called ${agentName}.

FAILURE:
- Test: ${failure.id} — ${failure.name}
- Prompt sent: "${failure.prompt}"
- Response received: "${(failure.response || "").slice(0, 500)}"
- Why it failed: ${failure.llmScore?.reasoning || "matched a fail pattern"}
- Pass criteria: ${JSON.stringify(failure.prompt)}

CURRENT SOUL.md (defines ${agentName}'s persona/behavior):
---
${soulContent.slice(0, 4000)}
---

CURRENT AGENTS.md:
---
${agentsContent.slice(0, 4000)}
---

Analyze why ${agentName} failed this test and suggest the MINIMAL edit to fix it.
Output your fix as a JSON object:

{
  "file": "SOUL.md or AGENTS.md or TOOLS.md or MEMORY.md",
  "analysis": "why it failed",
  "fix_description": "what to change",
  "search": "exact text to find in the file",
  "replace": "replacement text"
}

Rules:
- Make the SMALLEST possible change
- Don't remove existing behavior — augment it
- Don't over-specify — keep instructions general enough to handle similar cases
- Prefer adding a rule or example over rewriting existing text`;

    try {
      const result = execSync(`claude -p --model ${modelFlag}`, {
        input: fixPrompt,
        encoding: "utf-8",
        timeout: 60000,
      });

      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const fix = JSON.parse(jsonMatch[0]);
        console.log(`    Fix: ${fix.fix_description}`);
        console.log(`    File: ${fix.file}`);

        const targetFile = path.join(wsDir, fix.file);
        if (fs.existsSync(targetFile)) {
          let content = fs.readFileSync(targetFile, "utf-8");
          if (fix.search && content.includes(fix.search)) {
            content = content.replace(fix.search, fix.replace);
            fs.writeFileSync(targetFile, content);
            pushFileToContainer(containerName, stageDir, fix.file);
            console.log(`    Applied fix to ${fix.file}`);
            fixCount++;
          } else if (fix.replace && !fix.search) {
            content += "\n" + fix.replace;
            fs.writeFileSync(targetFile, content);
            pushFileToContainer(containerName, stageDir, fix.file);
            console.log(`    Appended fix to ${fix.file}`);
            fixCount++;
          } else {
            console.log(`    WARNING: Could not find search text in ${fix.file}`);
          }
        }
      }
    } catch (err) {
      console.error(`    Fix generation failed: ${err.message}`);
    }
  }

  if (fixCount > 0) {
    console.log(`\n  Applied ${fixCount} fix(es). Restarting container and re-testing...`);
    try {
      run(`docker restart ${containerName}`);
      await new Promise((r) => setTimeout(r, 15000));
    } catch {
      console.log("  Warning: container restart failed");
    }
    await phaseTest(opts);
  }

  return { fixed: fixCount, attempts: failures.length };
}

function readIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
}

// ── Phase 5: Report + Promote ──

async function phaseReport(scores, fixResults, opts) {
  console.log("\n━━━ Phase 5: Report ━━━\n");

  const resultsDir = path.join(LAB_ROOT, "agents", opts.agent, "results");
  let latestResults = { summary: { total: 0, passed: 0, failed: 0, errors: 0 }, results: [] };

  if (fs.existsSync(resultsDir)) {
    const resultFiles = fs
      .readdirSync(resultsDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();

    if (resultFiles.length > 0) {
      latestResults = JSON.parse(
        fs.readFileSync(path.join(resultsDir, resultFiles[0]), "utf-8")
      );
    }
  }

  const agentConfig = loadAgentConfig(opts.agent);
  const agentName = agentConfig.displayName || agentConfig.name;
  const dateStr = new Date().toISOString().slice(0, 10);

  const report = [
    `# Full Cycle Report — ${agentName} — ${dateStr}`,
    "",
    "## Test Results",
    `- **Passed:** ${latestResults.summary.passed}/${latestResults.summary.total}`,
    `- **Failed:** ${latestResults.summary.failed}/${latestResults.summary.total}`,
    `- **Errors:** ${latestResults.summary.errors}/${latestResults.summary.total}`,
    "",
    "## Workspace Scores",
    "",
    "| File | Score | Grade |",
    "|---|---|---|",
  ];

  for (const [file, score] of Object.entries(scores || {})) {
    report.push(`| ${file} | ${score.total}/${score.max} | ${score.grade} |`);
  }

  if (fixResults) {
    report.push("");
    report.push("## Fix Phase");
    report.push(`- **Fixes applied:** ${fixResults.fixed}/${fixResults.attempts}`);
  }

  report.push("", "## Scenario Details", "");
  report.push("| ID | Name | Verdict | Score |");
  report.push("|---|---|---|---|");
  for (const r of latestResults.results) {
    report.push(`| ${r.id} | ${r.name} | ${r.verdict} | ${r.llmScore?.score ?? "-"} |`);
  }

  const reportContent = report.join("\n");
  fs.mkdirSync(resultsDir, { recursive: true });
  const reportFile = path.join(resultsDir, `full-cycle-${dateStr}.md`);
  fs.writeFileSync(reportFile, reportContent);
  console.log(`  Report saved to ${reportFile}`);
  console.log(reportContent);

  if (opts.promote) {
    console.log("\n━━━ Promotion ━━━\n");
    if (latestResults.summary.failed > 0 || latestResults.summary.errors > 0) {
      console.log("  WARNING: Not all tests passed. Promotion requires all PASS.");
      console.log("  Run with --fix first, or manually review failures.");
      return;
    }
    run(`node "${path.join(LAB_ROOT, "docker", "promote.js")}" --agent ${opts.agent} --auto`);
  }
}

// ── Main ──

async function main() {
  const opts = parseArgs();
  const config = loadConfig();
  const agentConfig = loadAgentConfig(opts.agent);
  const containerName = getContainerName(config, opts.agent);
  const stageDir = path.join(LAB_ROOT, ".lab-staging", opts.agent);

  console.log("╔══════════════════════════════════════╗");
  console.log("║     OpenClaw Lab — Full Cycle        ║");
  console.log("╚══════════════════════════════════════╝");
  console.log(`\n  Agent: ${agentConfig.displayName || agentConfig.name}`);
  console.log(`  Model: ${opts.model}`);
  console.log(`  Budget cap: $${opts.maxBudget}`);
  console.log(`  Fix: ${opts.fix}`);
  console.log(`  Promote: ${opts.promote}`);

  const startTime = Date.now();

  if (opts.refresh) phaseRefresh(opts.agent);

  const testResult = await phaseTest(opts);
  const scores = await phaseScore(opts, containerName, stageDir);

  let fixResults = null;
  if (opts.fix) fixResults = await phaseFix(opts, containerName, stageDir);

  await phaseReport(scores, fixResults, opts);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nTotal time: ${elapsed}s`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
