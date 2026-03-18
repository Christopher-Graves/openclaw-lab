#!/usr/bin/env node
/**
 * init.js — Interactive agent design bootstrapper
 *
 * Creates a new agent project directory with workspace templates,
 * seed scenarios, and default rubrics.
 *
 * Usage:
 *   node workshop/init.js                    Interactive mode
 *   node workshop/init.js --name my-agent    Quick mode with defaults
 */

import fs from "fs";
import path from "path";
import readline from "readline";

const LAB_ROOT = path.resolve(import.meta.dirname, "..");
const TEMPLATES_DIR = path.join(LAB_ROOT, "workshop", "templates");

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function resolvePath(p) {
  const HOME = process.env.USERPROFILE || process.env.HOME;
  return p.replace(/^~/, HOME);
}

function renderTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  let quickName = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name") quickName = args[++i];
  }

  console.log("\n╔══════════════════════════════════════╗");
  console.log("║   OpenClaw Lab — Agent Workshop      ║");
  console.log("╚══════════════════════════════════════╝\n");

  // Gather agent info
  const name = quickName || await ask("  Agent name (lowercase, no spaces): ");
  if (!name || !/^[a-z0-9_-]+$/.test(name)) {
    console.error("  Invalid name. Use lowercase letters, numbers, hyphens, underscores.");
    process.exit(1);
  }

  const agentDir = path.join(LAB_ROOT, "agents", name);
  if (fs.existsSync(agentDir)) {
    console.error(`  Agent "${name}" already exists at ${agentDir}`);
    process.exit(1);
  }

  const displayName = quickName
    ? name.charAt(0).toUpperCase() + name.slice(1)
    : await ask(`  Display name [${name.charAt(0).toUpperCase() + name.slice(1)}]: `) ||
      name.charAt(0).toUpperCase() + name.slice(1);

  const description = quickName
    ? `OpenClaw agent: ${displayName}`
    : await ask("  Brief description: ") || `OpenClaw agent: ${displayName}`;

  const model = quickName
    ? "anthropic/claude-sonnet-4-6"
    : await ask("  Primary model [anthropic/claude-sonnet-4-6]: ") || "anthropic/claude-sonnet-4-6";

  const prodDir = quickName
    ? "~/.openclaw/workspace"
    : await ask("  Production workspace dir [~/.openclaw/workspace]: ") || "~/.openclaw/workspace";

  // Create directory structure
  console.log(`\n  Creating agent: ${displayName}...\n`);

  const wsDir = path.join(agentDir, "workspace");
  fs.mkdirSync(path.join(agentDir, "results"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "scores"), { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });

  // Write agent.json
  const agentConfig = {
    name,
    displayName,
    description,
    model,
    fallback: "anthropic/claude-haiku-4-5",
    workspaceFiles: ["SOUL.md", "AGENTS.md", "TOOLS.md", "MEMORY.md"],
    productionDir: prodDir,
    skipDocker: [],
  };
  fs.writeFileSync(path.join(agentDir, "agent.json"), JSON.stringify(agentConfig, null, 2));
  console.log("  Created agent.json");

  // Render and write workspace templates
  const templateVars = {
    agentName: displayName,
    agentNameLower: name,
    description,
    model,
  };

  const templateFiles = ["SOUL.md.hbs", "AGENTS.md.hbs", "TOOLS.md.hbs", "MEMORY.md.hbs"];
  for (const tmplFile of templateFiles) {
    const tmplPath = path.join(TEMPLATES_DIR, tmplFile);
    if (fs.existsSync(tmplPath)) {
      const template = fs.readFileSync(tmplPath, "utf-8");
      const rendered = renderTemplate(template, templateVars);
      const outFile = tmplFile.replace(".hbs", "");
      fs.writeFileSync(path.join(wsDir, outFile), rendered);
      console.log(`  Created workspace/${outFile}`);
    }
  }

  // Copy seed scenarios
  const seedPath = path.join(TEMPLATES_DIR, "scenarios.seed.json");
  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, "utf-8"));
    // Replace placeholder agent name in scenarios
    const rendered = JSON.stringify(seed, null, 2).replaceAll("{{agentName}}", displayName);
    fs.writeFileSync(path.join(agentDir, "scenarios.json"), rendered);
    console.log("  Created scenarios.json (5 seed scenarios)");
  }

  // Copy default rubrics
  const rubricsPath = path.join(TEMPLATES_DIR, "rubrics.default.json");
  if (fs.existsSync(rubricsPath)) {
    fs.copyFileSync(rubricsPath, path.join(agentDir, "rubrics.json"));
    console.log("  Created rubrics.json (default rubrics)");
  }

  // Create lab.config.json if it doesn't exist
  const labConfigPath = path.join(LAB_ROOT, "lab.config.json");
  if (!fs.existsSync(labConfigPath)) {
    const labConfig = {
      openclaw: {
        configDir: "~/.openclaw",
        envFile: "~/.openclaw/.env",
        skillsDir: "~/.openclaw/skills",
        gwsConfig: "~/.openclaw/gws-config",
        image: "ghcr.io/openclaw/openclaw:latest",
      },
      docker: {
        port: 28789,
        containerPrefix: "openclaw-lab",
      },
      scoring: {
        model: "haiku",
      },
    };
    fs.writeFileSync(labConfigPath, JSON.stringify(labConfig, null, 2));
    console.log("  Created lab.config.json");
  }

  console.log(`
  ════════════════════════════════════════

  Agent "${displayName}" created at agents/${name}/

  Next steps:
    1. Edit agents/${name}/workspace/SOUL.md to define the persona
    2. Edit agents/${name}/scenarios.json to add custom test scenarios
    3. Start the test environment:
       node docker/setup.js --agent ${name} --init
    4. Run the test suite:
       node tests/runner.js --agent ${name}
    5. Run the full cycle (test + score + fix):
       node tests/cycle.js --agent ${name} --fix

  ════════════════════════════════════════
`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
