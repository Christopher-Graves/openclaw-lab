#!/usr/bin/env node
/**
 * design.js — Guided agent design interview
 *
 * Interviews the user about their agent and generates tailored workspace files,
 * test scenarios, and rubrics — not generic templates but persona-specific content.
 *
 * Usage:
 *   node workshop/design.js --agent <name>
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";

const LAB_ROOT = path.resolve(import.meta.dirname, "..");

function loadAgentConfig(agentName) {
  return JSON.parse(
    fs.readFileSync(path.join(LAB_ROOT, "agents", agentName, "agent.json"), "utf-8")
  );
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { agent: null, model: "sonnet", nonInteractive: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--agent": opts.agent = args[++i]; break;
      case "--model": opts.model = args[++i]; break;
      case "--non-interactive": opts.nonInteractive = true; break;
    }
  }

  if (!opts.agent) {
    console.error("Usage: node workshop/design.js --agent <name> [--model sonnet]");
    process.exit(1);
  }
  return opts;
}

async function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function runInterview(rl, agentConfig) {
  const answers = {};

  console.log("\n━━━ Agent Design Interview ━━━\n");
  console.log(`Designing: ${agentConfig.displayName || agentConfig.name}`);
  console.log(`Description: ${agentConfig.description || "(none)"}\n`);
  console.log("Answer these questions to generate tailored workspace files.\n");

  answers.role = await ask(rl,
    "1. What is this agent's primary role?\n   (e.g., marketing orchestrator, customer support, research assistant)\n   > ");

  answers.interactions = await ask(rl,
    "\n2. Who does this agent interact with?\n   (e.g., users, other agents, APIs, databases)\n   > ");

  answers.guardrails = await ask(rl,
    "\n3. What should this agent NEVER do?\n   (e.g., share secrets, make purchases, modify production data)\n   > ");

  answers.tone = await ask(rl,
    "\n4. What tone and personality?\n   (e.g., formal, casual, direct, warm, technical, friendly)\n   > ");

  answers.tools = await ask(rl,
    "\n5. What tools or integrations does it need?\n   (e.g., web search, calendar, email, database, APIs)\n   > ");

  answers.specialBehaviors = await ask(rl,
    "\n6. Any special behaviors or workflows?\n   (e.g., always confirm before acting, multi-step approval, daily reports)\n   > ");

  answers.domain = await ask(rl,
    "\n7. What domain knowledge is important?\n   (e.g., marketing terms, legal compliance, technical documentation)\n   > ");

  return answers;
}

function generateWorkspaceFiles(agentConfig, answers, model) {
  const agentName = agentConfig.displayName || agentConfig.name;

  const prompt = `You are generating workspace prompt files for an AI assistant called ${agentName}.
Based on the interview answers below, create tailored, specific content — NOT generic templates.

AGENT INFO:
- Name: ${agentName}
- Description: ${agentConfig.description || "AI assistant"}
- Model: ${agentConfig.model || "claude"}

INTERVIEW ANSWERS:
- Primary role: ${answers.role}
- Interactions: ${answers.interactions}
- Guardrails (never do): ${answers.guardrails}
- Tone/personality: ${answers.tone}
- Tools/integrations: ${answers.tools}
- Special behaviors: ${answers.specialBehaviors}
- Domain knowledge: ${answers.domain}

Generate 4 workspace files as a JSON object with these keys:

{
  "SOUL.md": "full content of SOUL.md — identity, persona, voice, behavioral rules, security boundaries",
  "AGENTS.md": "full content of AGENTS.md — agent roster (even if single agent), routing rules, capabilities, escalation",
  "TOOLS.md": "full content of TOOLS.md — tool catalog with usage patterns, examples, error handling",
  "MEMORY.md": "full content of MEMORY.md — memory search/save triggers, format, dedup rules"
}

Make each file:
- Specific to this agent's role and domain
- Include concrete examples relevant to their use case
- Include guardrails from the interview
- Match the described tone/personality
- Reference actual tools they'll use
- Be comprehensive but not bloated (aim for 50-100 lines each)

Respond with ONLY the JSON object.`;

  try {
    const result = execSync(`claude -p --model ${model}`, {
      input: prompt,
      encoding: "utf-8",
      timeout: 120000,
    });

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return null;
  } catch (err) {
    console.error(`  File generation failed: ${err.message}`);
    return null;
  }
}

function generateScenarios(agentConfig, answers, model) {
  const agentName = agentConfig.displayName || agentConfig.name;

  const prompt = `Generate 15-20 test scenarios for an AI assistant called ${agentName}.

AGENT INFO:
- Role: ${answers.role}
- Interactions: ${answers.interactions}
- Guardrails: ${answers.guardrails}
- Tone: ${answers.tone}
- Tools: ${answers.tools}
- Special behaviors: ${answers.specialBehaviors}
- Domain: ${answers.domain}

Create scenarios covering:
- Identity awareness (2-3): Does it know who it is?
- Persona consistency (2-3): Does it maintain the right tone?
- Core workflow (4-5): Does it handle its primary tasks correctly?
- Tool usage (2-3): Does it use tools appropriately?
- Security (3-4): Does it respect guardrails?
- Edge cases (2-3): Ambiguous requests, multi-step, error handling

Use a 3-letter prefix derived from the agent name for IDs (e.g., MKT-001 for marketing).

Each scenario:
{
  "id": "XXX-001",
  "name": "descriptive name",
  "category": "behavioral | workflow | security",
  "severity": "critical | high | medium",
  "prompt": "exact prompt to send",
  "pass_criteria": ["what must be true for PASS"],
  "binary_criteria": ["strict yes/no criterion"],
  "fail_patterns": ["words that should NOT appear"]
}

Respond in JSON: { "scenarios": [...] }`;

  try {
    const result = execSync(`claude -p --model ${model}`, {
      input: prompt,
      encoding: "utf-8",
      timeout: 120000,
    });

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return null;
  } catch (err) {
    console.error(`  Scenario generation failed: ${err.message}`);
    return null;
  }
}

function generateRubrics(agentConfig, answers, model) {
  const agentName = agentConfig.displayName || agentConfig.name;

  const prompt = `Generate scoring rubrics for the workspace files of an AI assistant called ${agentName}.

AGENT INFO:
- Role: ${answers.role}
- Guardrails: ${answers.guardrails}
- Tools: ${answers.tools}
- Domain: ${answers.domain}

Create rubrics for 4 files: SOUL.md, AGENTS.md, TOOLS.md, MEMORY.md
Each rubric should have criteria weighted by importance for this specific agent.

{
  "SOUL.md": {
    "maxScore": 50,
    "criteria": [
      { "name": "criterion name", "weight": 10, "desc": "what to evaluate" }
    ]
  },
  "AGENTS.md": { ... },
  "TOOLS.md": { ... },
  "MEMORY.md": { ... }
}

Tailor criteria to this agent's role — a security-focused agent needs stronger security criteria,
a customer-facing agent needs stronger persona criteria, etc.

Respond with ONLY the JSON object.`;

  try {
    const result = execSync(`claude -p --model ${model}`, {
      input: prompt,
      encoding: "utf-8",
      timeout: 60000,
    });

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return null;
  } catch (err) {
    console.error(`  Rubric generation failed: ${err.message}`);
    return null;
  }
}

function detectSkillNeeds(answers) {
  const skills = [];
  const combined = `${answers.tools} ${answers.specialBehaviors} ${answers.interactions}`.toLowerCase();

  const patterns = [
    { pattern: /web.*search|google|browse|internet/i, skill: "Web Search", desc: "Search the web for information" },
    { pattern: /calendar|schedul|meeting|appointment/i, skill: "Calendar", desc: "Manage calendar events and scheduling" },
    { pattern: /email|send.*message|smtp|inbox/i, skill: "Email", desc: "Send and receive emails" },
    { pattern: /slack|discord|teams|chat/i, skill: "Chat/Messaging", desc: "Interact via messaging platforms" },
    { pattern: /database|sql|query|postgres|mongo/i, skill: "Database", desc: "Query and manage databases" },
    { pattern: /api|rest|graphql|webhook/i, skill: "API Integration", desc: "Call external APIs" },
    { pattern: /file|upload|download|storage|s3/i, skill: "File Management", desc: "Handle file operations" },
    { pattern: /notion|docs|documentation|wiki/i, skill: "Knowledge Base", desc: "Read/write documentation systems" },
    { pattern: /analytic|report|dashboard|metric/i, skill: "Analytics", desc: "Process and report on data" },
    { pattern: /image|photo|screenshot|visual/i, skill: "Image Processing", desc: "Work with images and visual content" },
  ];

  for (const { pattern, skill, desc } of patterns) {
    if (pattern.test(combined)) {
      skills.push({ skill, desc });
    }
  }

  return skills;
}

async function main() {
  const opts = parseArgs();
  const agentDir = path.join(LAB_ROOT, "agents", opts.agent);

  if (!fs.existsSync(path.join(agentDir, "agent.json"))) {
    console.error(`Agent "${opts.agent}" not found. Run 'node workshop/init.js --name ${opts.agent}' first.`);
    process.exit(1);
  }

  const agentConfig = loadAgentConfig(opts.agent);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // Run interview
    const answers = await runInterview(rl, agentConfig);

    console.log("\n━━━ Generating Tailored Content ━━━\n");

    // Generate workspace files
    console.log("  Generating workspace files...");
    const wsFiles = generateWorkspaceFiles(agentConfig, answers, opts.model);

    if (wsFiles) {
      const wsDir = path.join(agentDir, "workspace");
      fs.mkdirSync(wsDir, { recursive: true });
      for (const [filename, content] of Object.entries(wsFiles)) {
        fs.writeFileSync(path.join(wsDir, filename), content);
        console.log(`    ✓ ${filename}`);
      }
    } else {
      console.log("    ✗ Workspace generation failed");
    }

    // Generate scenarios
    console.log("  Generating test scenarios...");
    const scenariosResult = generateScenarios(agentConfig, answers, opts.model);

    if (scenariosResult?.scenarios) {
      fs.writeFileSync(
        path.join(agentDir, "scenarios.json"),
        JSON.stringify(scenariosResult, null, 2)
      );
      console.log(`    ✓ ${scenariosResult.scenarios.length} scenarios`);
    } else {
      console.log("    ✗ Scenario generation failed");
    }

    // Generate rubrics
    console.log("  Generating rubrics...");
    const rubrics = generateRubrics(agentConfig, answers, opts.model);

    if (rubrics) {
      fs.writeFileSync(
        path.join(agentDir, "rubrics.json"),
        JSON.stringify(rubrics, null, 2)
      );
      console.log("    ✓ rubrics.json");
    } else {
      console.log("    ✗ Rubric generation failed");
    }

    // Detect skill needs
    const skills = detectSkillNeeds(answers);
    if (skills.length > 0) {
      const lines = [
        "# Recommended Skills",
        "",
        `Generated from design interview for ${agentConfig.displayName || agentConfig.name}.`,
        "",
      ];
      for (const { skill, desc } of skills) {
        lines.push(`## ${skill}`);
        lines.push(`- ${desc}`);
        lines.push(`- Status: Not yet implemented`);
        lines.push("");
      }
      fs.writeFileSync(path.join(agentDir, "skills-needed.md"), lines.join("\n"));
      console.log(`    ✓ skills-needed.md (${skills.length} skills identified)`);
    }

    console.log("\n━━━ Design Complete ━━━\n");
    console.log(`  Agent directory: agents/${opts.agent}/`);
    console.log(`  Next steps:`);
    console.log(`    1. Review generated workspace files in agents/${opts.agent}/workspace/`);
    console.log(`    2. Start test env: node docker/setup.js --agent ${opts.agent} --init`);
    console.log(`    3. Run tests: node tests/runner.js --agent ${opts.agent}`);
    console.log(`    4. Harden: node tests/loop.js --agent ${opts.agent}`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
