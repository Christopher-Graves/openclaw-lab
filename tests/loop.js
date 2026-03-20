#!/usr/bin/env node
/**
 * loop.js — Autonomous hardening loop for OpenClaw agents
 *
 * Runs iterative mutation-test-keep/discard cycles until convergence.
 * Inspired by Karpathy's autoresearch: one mutation per experiment,
 * measure holistically, keep if improved, discard if not.
 *
 * Usage:
 *   node tests/loop.js --agent <name> [options]
 *
 * Options:
 *   --max-iterations 100     Budget cap (default: 100)
 *   --target-pass-rate 95    Success threshold % (default: 95)
 *   --stall-limit 10         Stop after N consecutive no-improvement (default: 10)
 *   --model sonnet            Model for mutation generation (default: sonnet)
 *   --mode docker|cli         Test mode (default: docker)
 *   --binary                  Force binary evals for all scenarios
 *   --discover                Enable auto-scenario generation at stall
 *   --verbose                 Show detailed output
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { runAllScenarios, summarizeResults } from "./runner.js";
import { saveSnapshot, restoreSnapshot } from "./lib/snapshot.js";
import { ExperimentTracker } from "./lib/tracker.js";
import { generateMutation, applyMutation, readWorkspaceFiles } from "./lib/mutator.js";
import { evaluateBinary } from "./lib/binary-eval.js";
import { analyzeGaps, generateScenarios } from "./lib/scenario-generator.js";
import { detectSkillGaps, writeSkillsNeeded } from "./lib/skill-detector.js";
import { generateDashboard } from "./dashboard.js";

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

function loadGatewayToken(config) {
  const envPath = resolvePath(config.openclaw.envFile);
  try {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("GATEWAY_AUTH_TOKEN=")) {
        return trimmed.slice("GATEWAY_AUTH_TOKEN=".length);
      }
    }
  } catch {}
  return "test-gateway-token-2026";
}

function getContainerName(config, agentName) {
  const prefix = config.docker?.containerPrefix || "openclaw-lab";
  return `${prefix}-${agentName}`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    agent: null,
    maxIterations: 100,
    targetPassRate: 95,
    stallLimit: 10,
    model: "sonnet",
    mode: "docker",
    binary: false,
    discover: false,
    verbose: false,
    timeout: 120000,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--agent": opts.agent = args[++i]; break;
      case "--max-iterations": opts.maxIterations = parseInt(args[++i]); break;
      case "--target-pass-rate": opts.targetPassRate = parseFloat(args[++i]); break;
      case "--stall-limit": opts.stallLimit = parseInt(args[++i]); break;
      case "--model": opts.model = args[++i]; break;
      case "--mode": opts.mode = args[++i]; break;
      case "--binary": opts.binary = true; break;
      case "--discover": opts.discover = true; break;
      case "--verbose": opts.verbose = true; break;
      case "--timeout": opts.timeout = parseInt(args[++i]); break;
    }
  }

  if (!opts.agent) {
    console.error("Usage: node tests/loop.js --agent <name> [options]");
    process.exit(1);
  }
  return opts;
}

function pushFileToContainer(containerName, workspaceDir, filename) {
  const localPath = path.join(workspaceDir, filename).replace(/\\/g, "/");
  try {
    execSync(`docker cp "${localPath}" ${containerName}:/home/node/.openclaw/workspace/${filename}`, {
      encoding: "utf-8",
      timeout: 10000,
    });
  } catch {
    console.log(`  Warning: could not push ${filename} to container`);
  }
}

function pushAllToContainer(containerName, workspaceDir) {
  if (!fs.existsSync(workspaceDir)) return;
  for (const file of fs.readdirSync(workspaceDir)) {
    if (fs.statSync(path.join(workspaceDir, file)).isFile()) {
      pushFileToContainer(containerName, workspaceDir, file);
    }
  }
}

function restartContainer(containerName) {
  try {
    execSync(`docker restart ${containerName}`, { encoding: "utf-8", timeout: 30000 });
  } catch {
    console.log("  Warning: container restart failed");
  }
}

async function waitForHealth(config) {
  const port = config.docker?.port || 28789;
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch(`http://localhost:${port}/healthz`);
      if (resp.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("  Warning: health check timed out");
  return false;
}

/**
 * Pick the highest-priority failing scenario, deprioritizing those targeted 3+ times without improvement.
 */
function pickTarget(failures, mutationHistory) {
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

  // Count times each scenario was targeted without improvement
  const targetCounts = {};
  for (const entry of mutationHistory) {
    if (entry.status === "DISCARD") {
      targetCounts[entry.targetScenario] = (targetCounts[entry.targetScenario] || 0) + 1;
    }
  }

  // Sort: severity first, then penalize scenarios targeted 3+ times
  const sorted = [...failures].sort((a, b) => {
    const aCount = targetCounts[a.id] || 0;
    const bCount = targetCounts[b.id] || 0;
    const aPenalty = aCount >= 3 ? 10 : 0;
    const bPenalty = bCount >= 3 ? 10 : 0;
    const aSev = (severityOrder[a.severity] || 2) + aPenalty;
    const bSev = (severityOrder[b.severity] || 2) + bPenalty;
    return aSev - bSev;
  });

  return sorted[0] || null;
}

/**
 * Compute pass rate and detect side effects (scenarios that changed state).
 */
function compareResults(prevResults, newResults) {
  const sideEffects = [];
  for (const nr of newResults) {
    const pr = prevResults.find((r) => r.id === nr.id);
    if (pr && pr.verdict !== nr.verdict) {
      sideEffects.push(`${nr.id}: ${pr.verdict} -> ${nr.verdict}`);
    }
  }
  return sideEffects;
}

// ── Main Loop ──

async function main() {
  const opts = parseArgs();
  const config = loadConfig();
  const agentConfig = loadAgentConfig(opts.agent);
  const token = loadGatewayToken(config);
  const containerName = getContainerName(config, opts.agent);
  const workspaceDir = path.join(LAB_ROOT, "agents", opts.agent, "workspace");
  const agentName = agentConfig.displayName || agentConfig.name;

  // Load scenarios
  const scenariosFile = path.join(LAB_ROOT, "agents", opts.agent, "scenarios.json");
  let scenariosData = JSON.parse(fs.readFileSync(scenariosFile, "utf-8"));
  let scenarios = scenariosData.scenarios;

  console.log("╔══════════════════════════════════════════╗");
  console.log("║   OpenClaw Lab — Autonomous Hardening    ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`\n  Agent: ${agentName}`);
  console.log(`  Scenarios: ${scenarios.length}`);
  console.log(`  Max iterations: ${opts.maxIterations}`);
  console.log(`  Target pass rate: ${opts.targetPassRate}%`);
  console.log(`  Stall limit: ${opts.stallLimit}`);
  console.log(`  Model: ${opts.model}`);
  console.log(`  Mode: ${opts.mode}`);
  console.log(`  Binary evals: ${opts.binary}`);
  console.log(`  Auto-discover: ${opts.discover}`);

  const tracker = new ExperimentTracker(opts.agent);
  const mutationHistory = []; // { iteration, targetScenario, mutation, status }
  let stallCounter = 0;
  let bestPassRate = 0;
  let stopReason = null;

  // ── SIGINT handler ──
  let interrupted = false;
  process.on("SIGINT", () => {
    console.log("\n\n  SIGINT received — finishing current iteration and saving state...");
    interrupted = true;
  });

  // ── Step 1: Baseline ──
  console.log("\n━━━ Running Baseline ━━━\n");

  const runOpts = {
    agent: opts.agent,
    mode: opts.mode,
    scenario: null,
    category: null,
    dryRun: false,
    verbose: opts.verbose,
    timeout: opts.timeout,
  };

  let baselineResults = await runAllScenarios(scenarios, runOpts, config, agentConfig, token);
  let baselineSummary = summarizeResults(baselineResults);

  bestPassRate = baselineSummary.passRate;
  console.log(`\n  Baseline: ${bestPassRate.toFixed(1)}% (${baselineSummary.passed}/${baselineSummary.total})`);

  // Save baseline snapshot
  saveSnapshot(opts.agent, "best", workspaceDir);
  saveSnapshot(opts.agent, "baseline", workspaceDir);

  tracker.initRun({
    passRate: bestPassRate,
    passed: baselineSummary.passed,
    total: baselineSummary.total,
  });

  // Check if already at target
  if (bestPassRate >= opts.targetPassRate) {
    console.log(`\n  Already at target (${opts.targetPassRate}%). Nothing to do.`);
    stopReason = "target_reached";
  }

  let previousResults = baselineResults;

  // ── Step 2: Loop ──
  for (let iteration = 1; iteration <= opts.maxIterations && !stopReason && !interrupted; iteration++) {
    console.log(`\n━━━ Iteration ${iteration}/${opts.maxIterations} (best: ${bestPassRate.toFixed(1)}%, stall: ${stallCounter}/${opts.stallLimit}) ━━━`);

    // Get current failures
    const failures = previousResults.filter((r) => r.verdict === "FAIL" || r.verdict === "ERROR");
    if (failures.length === 0) {
      stopReason = "all_passing";
      break;
    }

    // Pick target
    const target = pickTarget(failures, mutationHistory);
    if (!target) {
      stopReason = "no_target";
      break;
    }
    console.log(`\n  Target: ${target.id} — ${target.name}`);

    // Get previous mutations for this scenario
    const prevMutations = mutationHistory
      .filter((m) => m.targetScenario === target.id)
      .map((m) => ({ ...m.mutation, status: m.status }));

    // Generate mutation
    const wsFiles = readWorkspaceFiles(workspaceDir);
    const mutation = generateMutation(target, failures, wsFiles, agentConfig, {
      model: opts.model,
      previousMutations: prevMutations,
    });

    if (!mutation) {
      console.log("  Failed to generate mutation — skipping");
      stallCounter++;
      mutationHistory.push({
        iteration,
        targetScenario: target.id,
        mutation: { description: "generation failed", type: "error" },
        status: "DISCARD",
      });
      if (stallCounter >= opts.stallLimit) {
        stopReason = "stall_limit";
      }
      continue;
    }

    console.log(`  Mutation: ${mutation.description}`);
    console.log(`  File: ${mutation.file} (${mutation.type})`);

    // Apply mutation
    const applied = applyMutation(mutation, workspaceDir);
    if (!applied) {
      console.log("  Failed to apply mutation — skipping");
      stallCounter++;
      mutationHistory.push({
        iteration,
        targetScenario: target.id,
        mutation,
        status: "DISCARD",
      });
      if (stallCounter >= opts.stallLimit) {
        stopReason = "stall_limit";
      }
      continue;
    }

    // Push to container and restart (Docker mode)
    if (opts.mode === "docker") {
      pushFileToContainer(containerName, workspaceDir, mutation.file);
      restartContainer(containerName);
      await waitForHealth(config);
    }

    // Re-run ALL scenarios
    console.log("  Re-running all scenarios...");
    const newResults = await runAllScenarios(scenarios, runOpts, config, agentConfig, token);
    const newSummary = summarizeResults(newResults);
    const sideEffects = compareResults(previousResults, newResults);

    console.log(`  Result: ${newSummary.passRate.toFixed(1)}% (${newSummary.passed}/${newSummary.total})`);

    if (newSummary.passRate > bestPassRate) {
      // KEEP
      console.log(`  ✓ KEEP — improved from ${bestPassRate.toFixed(1)}% to ${newSummary.passRate.toFixed(1)}%`);
      stallCounter = 0;
      const previousPassRate = bestPassRate;
      bestPassRate = newSummary.passRate;
      previousResults = newResults;

      saveSnapshot(opts.agent, "best", workspaceDir);

      tracker.logExperiment({
        iteration,
        passRate: newSummary.passRate,
        passed: newSummary.passed,
        total: newSummary.total,
        status: "KEEP",
        targetScenario: target.id,
        mutation,
        previousPassRate,
        sideEffects,
      });

      mutationHistory.push({
        iteration,
        targetScenario: target.id,
        mutation,
        status: "KEEP",
      });

      // Check target
      if (bestPassRate >= opts.targetPassRate) {
        stopReason = "target_reached";
      }
    } else {
      // DISCARD
      console.log(`  ✗ DISCARD — no improvement (${newSummary.passRate.toFixed(1)}% vs best ${bestPassRate.toFixed(1)}%)`);
      stallCounter++;

      tracker.logExperiment({
        iteration,
        passRate: newSummary.passRate,
        passed: newSummary.passed,
        total: newSummary.total,
        status: "DISCARD",
        targetScenario: target.id,
        mutation,
        previousPassRate: bestPassRate,
        sideEffects,
      });

      mutationHistory.push({
        iteration,
        targetScenario: target.id,
        mutation,
        status: "DISCARD",
      });

      // Restore best snapshot
      restoreSnapshot(opts.agent, "best", workspaceDir);
      if (opts.mode === "docker") {
        pushAllToContainer(containerName, workspaceDir);
        restartContainer(containerName);
        await waitForHealth(config);
      }

      // Auto-discover at stall threshold
      if (opts.discover && stallCounter === 5) {
        console.log("\n  Stall detected — running gap analysis...");
        const wsFiles = readWorkspaceFiles(workspaceDir);
        const gaps = analyzeGaps(previousResults, scenarios, wsFiles, { model: opts.model });

        if (gaps.length > 0) {
          const nextIndex = scenarios.length + 1;
          const agentPrefix = (agentConfig.name || "AGENT").toUpperCase().slice(0, 3);
          const newScenarios = generateScenarios(gaps, agentConfig, {
            model: opts.model,
            idPrefix: agentPrefix,
            startIndex: nextIndex,
          });

          if (newScenarios.length > 0) {
            // Save proposed scenarios
            const proposedPath = path.join(LAB_ROOT, "agents", opts.agent, "proposed-scenarios.json");
            fs.writeFileSync(proposedPath, JSON.stringify({ scenarios: newScenarios }, null, 2));
            console.log(`  Proposed ${newScenarios.length} new scenarios → ${proposedPath}`);

            for (const s of newScenarios) {
              tracker.logProposedScenario(s);
            }
          }
        }
      }

      // Skill gap detection
      if (stallCounter >= 5) {
        const tsvResults = tracker.readResults();
        const currentFailures = previousResults.filter((r) => r.verdict !== "PASS");
        const wsFiles = readWorkspaceFiles(workspaceDir);
        const skillGaps = detectSkillGaps(tsvResults, currentFailures, wsFiles);
        if (skillGaps.length > 0) {
          writeSkillsNeeded(opts.agent, skillGaps);
          console.log(`  Skill gaps detected → agents/${opts.agent}/skills-needed.md`);
        }
      }

      if (stallCounter >= opts.stallLimit) {
        stopReason = "stall_limit";
      }
    }

    // Check iteration budget
    if (iteration >= opts.maxIterations) {
      stopReason = "max_iterations";
    }
  }

  if (interrupted && !stopReason) {
    stopReason = "interrupted";
  }

  // ── Step 3: Finalize ──
  console.log("\n━━━ Hardening Complete ━━━\n");

  // Restore best snapshot
  restoreSnapshot(opts.agent, "best", workspaceDir);
  if (opts.mode === "docker") {
    pushAllToContainer(containerName, workspaceDir);
    restartContainer(containerName);
  }

  const kept = mutationHistory.filter((m) => m.status === "KEEP").length;
  const discarded = mutationHistory.filter((m) => m.status === "DISCARD").length;

  tracker.logSummary({
    reason: stopReason,
    iterations: mutationHistory.length,
    finalPassRate: bestPassRate,
    baselinePassRate: baselineSummary.passRate,
    kept,
    discarded,
  });

  console.log(`  Stop reason: ${stopReason}`);
  console.log(`  Iterations: ${mutationHistory.length}`);
  console.log(`  Baseline: ${baselineSummary.passRate.toFixed(1)}%`);
  console.log(`  Final: ${bestPassRate.toFixed(1)}%`);
  console.log(`  Improvement: +${(bestPassRate - baselineSummary.passRate).toFixed(1)}%`);
  console.log(`  Kept: ${kept} | Discarded: ${discarded}`);

  // Generate dashboard
  try {
    const dashboardPath = generateDashboard(opts.agent);
    console.log(`\n  Dashboard: ${dashboardPath}`);
  } catch (err) {
    if (opts.verbose) console.log(`  Dashboard generation failed: ${err.message}`);
  }

  console.log(`\n  Changelog: agents/${opts.agent}/results/changelog.md`);
  console.log(`  Results: agents/${opts.agent}/results/results.tsv`);
  console.log(`  Best workspace: agents/${opts.agent}/workspace/`);

  if (bestPassRate < opts.targetPassRate) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
