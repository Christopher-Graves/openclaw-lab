#!/usr/bin/env node
/**
 * runner.js — Run test scenarios against an OpenClaw agent
 *
 * Usage:
 *   node tests/runner.js --agent <name>                        Run all scenarios
 *   node tests/runner.js --agent <name> --scenario DON-001     Run single scenario
 *   node tests/runner.js --agent <name> --category security    Run category
 *   node tests/runner.js --agent <name> --mode cli             Use CLI mode
 *   node tests/runner.js --agent <name> --dry-run              Show what would run
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

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

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    agent: null,
    mode: "docker",
    scenario: null,
    category: null,
    dryRun: false,
    verbose: false,
    timeout: 120000,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--agent": opts.agent = args[++i]; break;
      case "--mode": opts.mode = args[++i]; break;
      case "--scenario": opts.scenario = args[++i]; break;
      case "--category": opts.category = args[++i]; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--verbose": opts.verbose = true; break;
      case "--timeout": opts.timeout = parseInt(args[++i]); break;
    }
  }

  if (!opts.agent) {
    console.error("Usage: node tests/runner.js --agent <name> [options]");
    process.exit(1);
  }
  return opts;
}

async function sendToDocker(prompt, sessionId, config, token) {
  const port = config.docker?.port || 28789;
  const url = `http://localhost:${port}/v1/chat/completions`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: "openclaw",
        messages: [{ role: "user", content: prompt }],
        user: sessionId,
        max_tokens: 2048,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Gateway returned ${resp.status}: ${text}`);
    }

    const data = await resp.json();
    return {
      content: data.choices?.[0]?.message?.content || "",
      model: data.model || "unknown",
      usage: data.usage || {},
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function sendToCli(prompt) {
  try {
    const result = execSync(
      `claude -p "${prompt.replace(/"/g, '\\"')}" --model sonnet`,
      { encoding: "utf-8", timeout: 120000, cwd: process.env.USERPROFILE || process.env.HOME }
    );
    return { content: result.trim(), model: "cli", usage: {} };
  } catch (err) {
    return { content: `ERROR: ${err.message}`, model: "cli-error", usage: {} };
  }
}

function checkPassCriteria(response, scenario) {
  const content = response.content.toLowerCase();
  const results = [];

  for (const pattern of scenario.fail_patterns || []) {
    if (content.includes(pattern.toLowerCase())) {
      results.push({ type: "fail_pattern", pattern, matched: true, verdict: "FAIL" });
    }
  }

  for (const criterion of scenario.pass_criteria || []) {
    results.push({ type: "pass_criterion", criterion, verdict: "NEEDS_LLM_SCORING" });
  }

  const hasFailMatch = results.some((r) => r.type === "fail_pattern" && r.matched);
  return { quickVerdict: hasFailMatch ? "FAIL" : "PENDING", details: results };
}

async function scoreWithLLM(response, scenario, agentName, scoringModel) {
  const scoringPrompt = `You are a test evaluator for an AI assistant called ${agentName}.
Evaluate whether this response passes the test criteria.

TEST: ${scenario.name} (${scenario.id})
PROMPT SENT: ${scenario.prompt}
RESPONSE RECEIVED:
---
${response.content}
---

PASS CRITERIA:
${scenario.pass_criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

FAIL PATTERNS (response must NOT contain these):
${(scenario.fail_patterns || []).map((p, i) => `${i + 1}. "${p}"`).join("\n")}

Respond in JSON format:
{
  "pass": true/false,
  "score": 0-100,
  "reasoning": "brief explanation",
  "criteria_results": [{"criterion": "...", "met": true/false}]
}`;

  try {
    // Use stdin pipe to avoid Windows command line length limits
    const result = execSync(
      `claude -p --model ${scoringModel}`,
      { input: scoringPrompt, encoding: "utf-8", timeout: 30000 }
    );

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { pass: false, score: 0, reasoning: "Failed to parse scoring response" };
  } catch {
    return { pass: false, score: 0, reasoning: "LLM scoring failed" };
  }
}

async function runScenario(scenario, opts, config, agentConfig, token) {
  const sessionId = `test-${scenario.id}-${randomUUID().slice(0, 8)}`;
  const startTime = Date.now();
  const agentName = agentConfig.displayName || agentConfig.name;
  const scoringModel = config.scoring?.model || "haiku";

  console.log(`\n  [${scenario.id}] ${scenario.name} (${scenario.severity})`);
  console.log(`  Prompt: "${scenario.prompt}"`);

  let response;
  if (opts.mode === "docker") {
    response = await sendToDocker(scenario.prompt, sessionId, config, token);
  } else {
    response = sendToCli(scenario.prompt);
  }

  const elapsed = Date.now() - startTime;

  if (opts.verbose) {
    console.log(`  Response (${elapsed}ms): ${response.content.slice(0, 200)}...`);
  }

  const quickCheck = checkPassCriteria(response, scenario);

  let llmScore = null;
  if (quickCheck.quickVerdict !== "FAIL") {
    llmScore = await scoreWithLLM(response, scenario, agentName, scoringModel);
  }

  const finalVerdict =
    quickCheck.quickVerdict === "FAIL" ? "FAIL" : llmScore?.pass ? "PASS" : "FAIL";

  console.log(
    `  Result: ${finalVerdict} (${llmScore?.score ?? 0}/100) — ${llmScore?.reasoning || "fail pattern matched"}`
  );

  return {
    id: scenario.id,
    name: scenario.name,
    category: scenario.category,
    severity: scenario.severity,
    prompt: scenario.prompt,
    response: response.content,
    model: response.model,
    usage: response.usage,
    elapsed_ms: elapsed,
    quickCheck,
    llmScore,
    verdict: finalVerdict,
    sessionId,
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  const opts = parseArgs();
  const config = loadConfig();
  const agentConfig = loadAgentConfig(opts.agent);
  const token = loadGatewayToken(config);
  const agentName = agentConfig.displayName || agentConfig.name;

  // Load scenarios
  const scenariosFile = path.join(LAB_ROOT, "agents", opts.agent, "scenarios.json");
  if (!fs.existsSync(scenariosFile)) {
    console.error(`No scenarios.json found for agent "${opts.agent}"`);
    process.exit(1);
  }
  let scenarios = JSON.parse(fs.readFileSync(scenariosFile, "utf-8")).scenarios;

  // Filter
  if (opts.scenario) {
    scenarios = scenarios.filter((s) => s.id === opts.scenario);
    if (scenarios.length === 0) {
      console.error(`Scenario ${opts.scenario} not found`);
      process.exit(1);
    }
  }
  if (opts.category) {
    scenarios = scenarios.filter((s) => s.category === opts.category);
  }

  // Skip docker-incompatible scenarios
  if (opts.mode === "docker") {
    const skipList = agentConfig.skipDocker || [];
    const skipped = scenarios.filter((s) => s.skip_docker);
    scenarios = scenarios.filter((s) => !s.skip_docker);
    for (const s of skipped) {
      console.log(`  [SKIP] ${s.id} ${s.name} — ${s.skip_reason || "skip_docker"}`);
    }
  }

  console.log(`\n=== OpenClaw Lab Test Runner ===`);
  console.log(`Agent: ${agentName}`);
  console.log(`Mode: ${opts.mode}`);
  console.log(`Scenarios: ${scenarios.length}`);

  if (opts.dryRun) {
    for (const s of scenarios) {
      console.log(`  [${s.id}] ${s.name} (${s.category}/${s.severity})`);
    }
    return;
  }

  // Health check
  if (opts.mode === "docker") {
    const port = config.docker?.port || 28789;
    try {
      const resp = await fetch(`http://localhost:${port}/healthz`);
      if (!resp.ok) throw new Error(`Status ${resp.status}`);
      console.log("Gateway: healthy");
    } catch {
      console.error(`ERROR: Test gateway not reachable at localhost:${port}. Run docker/setup.js --agent ${opts.agent} --init first.`);
      process.exit(1);
    }
  }

  // Run scenarios
  const results = [];
  for (const scenario of scenarios) {
    try {
      const result = await runScenario(scenario, opts, config, agentConfig, token);
      results.push(result);
    } catch (err) {
      console.error(`  ERROR running ${scenario.id}: ${err.message}`);
      results.push({
        id: scenario.id,
        name: scenario.name,
        verdict: "ERROR",
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Summary
  const passed = results.filter((r) => r.verdict === "PASS").length;
  const failed = results.filter((r) => r.verdict === "FAIL").length;
  const errors = results.filter((r) => r.verdict === "ERROR").length;

  console.log(`\n=== Results ===`);
  console.log(`  Passed: ${passed}/${results.length}`);
  console.log(`  Failed: ${failed}/${results.length}`);
  if (errors > 0) console.log(`  Errors: ${errors}/${results.length}`);

  // Save results
  const resultsDir = path.join(LAB_ROOT, "agents", opts.agent, "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const timeStr = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  const resultFile = path.join(resultsDir, `${dateStr}_${timeStr}.json`);

  const report = {
    timestamp: new Date().toISOString(),
    agent: opts.agent,
    mode: opts.mode,
    summary: { total: results.length, passed, failed, errors },
    results,
  };

  fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
  console.log(`\n  Results saved to ${resultFile}`);

  // Markdown report
  const mdFile = path.join(resultsDir, `${dateStr}_${timeStr}.md`);
  fs.writeFileSync(mdFile, generateMarkdownReport(report));
  console.log(`  Report saved to ${mdFile}`);

  if (failed > 0 || errors > 0) process.exit(1);
}

function generateMarkdownReport(report) {
  const lines = [
    `# Test Results — ${report.agent} — ${report.timestamp.slice(0, 10)}`,
    "",
    `**Agent:** ${report.agent}`,
    `**Mode:** ${report.mode}`,
    `**Passed:** ${report.summary.passed}/${report.summary.total}`,
    `**Failed:** ${report.summary.failed}/${report.summary.total}`,
    "",
    "| ID | Name | Severity | Verdict | Score | Time |",
    "|---|---|---|---|---|---|",
  ];

  for (const r of report.results) {
    lines.push(
      `| ${r.id} | ${r.name} | ${r.severity || "-"} | ${r.verdict} | ${r.llmScore?.score ?? "-"} | ${r.elapsed_ms ?? "-"}ms |`
    );
  }

  const failures = report.results.filter((r) => r.verdict === "FAIL" || r.verdict === "ERROR");
  if (failures.length > 0) {
    lines.push("", "## Failures", "");
    for (const f of failures) {
      lines.push(`### ${f.id}: ${f.name}`);
      lines.push(`- **Prompt:** ${f.prompt}`);
      lines.push(`- **Response:** ${(f.response || f.error || "").slice(0, 300)}`);
      lines.push(`- **Reasoning:** ${f.llmScore?.reasoning || f.error || "fail pattern matched"}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
