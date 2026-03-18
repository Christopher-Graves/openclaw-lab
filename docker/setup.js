#!/usr/bin/env node
/**
 * setup.js — Initialize or refresh an OpenClaw Lab test environment
 *
 * Usage:
 *   node docker/setup.js --agent <name> --init      First-time setup
 *   node docker/setup.js --agent <name> --refresh   Pull latest production workspace files
 *   node docker/setup.js --agent <name> --stop      Stop the test container
 *   node docker/setup.js --agent <name> --status    Check container health
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const LAB_ROOT = path.resolve(import.meta.dirname, "..");

function loadConfig() {
  const configPath = path.join(LAB_ROOT, "lab.config.json");
  if (!fs.existsSync(configPath)) {
    console.error("ERROR: lab.config.json not found. Run `node workshop/init.js` first.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function loadAgentConfig(agentName) {
  const agentPath = path.join(LAB_ROOT, "agents", agentName, "agent.json");
  if (!fs.existsSync(agentPath)) {
    console.error(`ERROR: Agent "${agentName}" not found at ${agentPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(agentPath, "utf-8"));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { agent: null, command: null };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--agent": opts.agent = args[++i]; break;
      case "--init": opts.command = "init"; break;
      case "--refresh": opts.command = "refresh"; break;
      case "--stop": opts.command = "stop"; break;
      case "--status": opts.command = "status"; break;
    }
  }
  if (!opts.agent) {
    console.error("Usage: node docker/setup.js --agent <name> [--init|--refresh|--stop|--status]");
    process.exit(1);
  }
  if (!opts.command) {
    console.error("Specify one of: --init, --refresh, --stop, --status");
    process.exit(1);
  }
  return opts;
}

function resolvePath(p) {
  const HOME = process.env.USERPROFILE || process.env.HOME;
  return p.replace(/^~/, HOME);
}

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { stdio: "inherit", ...opts });
}

function runCapture(cmd) {
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

function loadProdEnv(envFile) {
  const envPath = resolvePath(envFile);
  if (!fs.existsSync(envPath)) {
    console.error(`ERROR: .env not found at ${envPath}`);
    process.exit(1);
  }
  const env = {};
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

function stageWorkspaceFiles(config, agentConfig, stageDir) {
  const prodDir = resolvePath(config.openclaw.configDir);
  const srcDir = path.join(prodDir, "workspace");
  const destDir = path.join(stageDir, "workspace");
  fs.mkdirSync(destDir, { recursive: true });

  const files = agentConfig.workspaceFiles || [
    "SOUL.md", "AGENTS.md", "TOOLS.md", "MEMORY.md",
  ];

  let copied = 0;
  for (const file of files) {
    // Check agent workspace first, then production
    const agentSrc = path.join(LAB_ROOT, "agents", agentConfig.name, "workspace", file);
    const prodSrc = path.join(srcDir, file);
    const src = fs.existsSync(agentSrc) ? agentSrc : prodSrc;
    const dest = path.join(destDir, file);

    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      copied++;
      console.log(`  Staged ${file}`);
    }
  }

  // Also copy memory/ subdirectory if it exists
  const memSrc = path.join(srcDir, "memory");
  const memDest = path.join(destDir, "memory");
  if (fs.existsSync(memSrc)) {
    fs.cpSync(memSrc, memDest, { recursive: true });
    console.log("  Staged memory/");
  }

  return copied;
}

function stageTestConfig(config, agentConfig, stageDir) {
  const prodDir = resolvePath(config.openclaw.configDir);
  const prodConfigPath = path.join(prodDir, "openclaw.json");

  if (!fs.existsSync(prodConfigPath)) {
    console.error(`ERROR: openclaw.json not found at ${prodConfigPath}`);
    process.exit(1);
  }

  const prodConfig = JSON.parse(fs.readFileSync(prodConfigPath, "utf-8"));
  const testConfig = JSON.parse(JSON.stringify(prodConfig));

  // Remove channels/plugins unless agent config says otherwise
  if (!agentConfig.keepSlack) {
    delete testConfig.channels;
    delete testConfig.plugins;
  }

  // Clean up unknown config keys
  delete testConfig.commands?.ownerDisplay;
  if (testConfig.agents?.defaults?.memorySearch?.query?.hybrid) {
    delete testConfig.agents.defaults.memorySearch.query.hybrid.mmr;
    delete testConfig.agents.defaults.memorySearch.query.hybrid.temporalDecay;
  }

  // Enable HTTP chat completions endpoint
  testConfig.gateway = {
    port: 18789,
    mode: "local",
    bind: "lan",
    auth: {
      mode: "token",
      token: "${GATEWAY_AUTH_TOKEN}",
    },
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  };

  // Update workspace path for Linux container
  testConfig.agents.defaults.workspace = "/home/node/.openclaw/workspace";

  fs.writeFileSync(
    path.join(stageDir, "openclaw.json"),
    JSON.stringify(testConfig, null, 2)
  );
  console.log("  Staged openclaw.json (HTTP chat completions enabled)");
}

function stageAgentFiles(config, stageDir) {
  const prodDir = resolvePath(config.openclaw.configDir);

  // Auth profiles
  const authDir = path.join(stageDir, "agents", "main", "agent");
  fs.mkdirSync(authDir, { recursive: true });
  const authSrc = path.join(prodDir, "agents", "main", "agent", "auth-profiles.json");
  if (fs.existsSync(authSrc)) {
    fs.copyFileSync(authSrc, path.join(authDir, "auth-profiles.json"));
    console.log("  Staged auth-profiles.json");
  }

  // Sessions
  const sessDir = path.join(stageDir, "agents", "main", "sessions");
  fs.mkdirSync(sessDir, { recursive: true });
  const sessSrc = path.join(prodDir, "agents", "main", "sessions", "sessions.json");
  if (fs.existsSync(sessSrc)) {
    fs.copyFileSync(sessSrc, path.join(sessDir, "sessions.json"));
    console.log("  Staged sessions.json");
  }
}

function getContainerName(config, agentName) {
  const prefix = config.docker?.containerPrefix || "openclaw-lab";
  return `${prefix}-${agentName}`;
}

function getPort(config) {
  return config.docker?.port || 28789;
}

function getComposeEnv(config, agentConfig, containerName) {
  const prodEnv = loadProdEnv(config.openclaw.envFile);
  const skillsDir = resolvePath(config.openclaw.skillsDir || "~/.openclaw/skills");
  const gwsConfig = resolvePath(config.openclaw.gwsConfig || "~/.openclaw/gws-config");

  return {
    ...process.env,
    ...prodEnv,
    LAB_CONTAINER: containerName,
    LAB_VOLUME: `${containerName}-config`,
    LAB_PORT: String(getPort(config)),
    OPENCLAW_IMAGE: config.openclaw.image || "ghcr.io/openclaw/openclaw:latest",
    OPENCLAW_SKILLS_DIR: skillsDir.replace(/\\/g, "/"),
    OPENCLAW_GWS_CONFIG: gwsConfig.replace(/\\/g, "/"),
    GATEWAY_AUTH_TOKEN: prodEnv.GATEWAY_AUTH_TOKEN || "",
    ANTHROPIC_API_TOKEN: prodEnv.ANTHROPIC_API_TOKEN || "",
  };
}

function composePath() {
  return path.join(LAB_ROOT, "docker", "docker-compose.yml").replace(/\\/g, "/");
}

function dockerCpToContainer(stageDir, containerName) {
  const stagePath = stageDir.replace(/\\/g, "/");

  console.log("  Copying config into container volume...");
  run(`docker cp "${stagePath}/openclaw.json" ${containerName}:/home/node/.openclaw/openclaw.json`);
  run(`docker cp "${stagePath}/workspace/." ${containerName}:/home/node/.openclaw/workspace/`);
  run(`docker cp "${stagePath}/agents/." ${containerName}:/home/node/.openclaw/agents/`);
  run(`docker exec -u root ${containerName} sh -c "chown -R node:node /home/node/.openclaw/workspace /home/node/.openclaw/agents /home/node/.openclaw/openclaw.json"`);
  console.log("  Files copied and permissions fixed");
}

async function waitForHealthy(port, maxWait = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const resp = await fetch(`http://localhost:${port}/healthz`);
      if (resp.ok) {
        console.log("\n  Container is healthy!");
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
    process.stdout.write(".");
  }
  console.log("\n  WARNING: Container did not become healthy within timeout");
  return false;
}

async function waitForContainer(containerName, maxWait = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const status = runCapture(`docker inspect -f "{{.State.Running}}" ${containerName}`);
      if (status === "true") return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ── Commands ──

async function init(config, agentConfig, containerName) {
  const stageDir = path.join(LAB_ROOT, ".lab-staging", agentConfig.name);
  const port = getPort(config);

  console.log(`\n=== Initializing Lab Environment for ${agentConfig.displayName || agentConfig.name} ===\n`);

  console.log("1. Staging files locally...");
  fs.mkdirSync(stageDir, { recursive: true });
  const copied = stageWorkspaceFiles(config, agentConfig, stageDir);
  console.log(`  ${copied} workspace files staged`);

  console.log("\n2. Creating test configuration...");
  stageTestConfig(config, agentConfig, stageDir);
  stageAgentFiles(config, stageDir);

  console.log("\n3. Cleaning up any existing test environment...");
  const env = getComposeEnv(config, agentConfig, containerName);
  try {
    run(`docker compose -f "${composePath()}" -p ${containerName} down -v`, { env });
  } catch {}

  console.log("\n4. Starting test container...");
  run(`docker compose -f "${composePath()}" -p ${containerName} up -d`, { env });

  console.log("\n5. Waiting for container to start...");
  await waitForContainer(containerName);

  console.log("\n6. Copying config into container...");
  dockerCpToContainer(stageDir, containerName);

  console.log("\n7. Restarting container with config...");
  run(`docker restart ${containerName}`);

  console.log("\n8. Waiting for gateway to be healthy...");
  await waitForContainer(containerName);
  await waitForHealthy(port);

  console.log(`\n=== Lab Environment Ready ===`);
  console.log(`  Agent:     ${agentConfig.displayName || agentConfig.name}`);
  console.log(`  Staging:   ${stageDir}`);
  console.log(`  Gateway:   http://localhost:${port}`);
  console.log(`  Health:    http://localhost:${port}/healthz`);
}

async function refresh(config, agentConfig, containerName) {
  const stageDir = path.join(LAB_ROOT, ".lab-staging", agentConfig.name);
  const port = getPort(config);

  console.log(`\n=== Refreshing Lab Environment for ${agentConfig.displayName || agentConfig.name} ===\n`);

  console.log("1. Staging latest workspace files...");
  const copied = stageWorkspaceFiles(config, agentConfig, stageDir);
  console.log(`  ${copied} files staged`);

  console.log("\n2. Updating test configuration...");
  stageTestConfig(config, agentConfig, stageDir);

  console.log("\n3. Copying into container...");
  dockerCpToContainer(stageDir, containerName);

  console.log("\n4. Restarting container...");
  run(`docker restart ${containerName}`);

  console.log("\n5. Waiting for gateway to be healthy...");
  await waitForContainer(containerName);
  await waitForHealthy(port);

  console.log("\n=== Lab Environment Refreshed ===");
}

function stop(config, agentConfig, containerName) {
  console.log(`\nStopping ${containerName}...`);
  const env = getComposeEnv(config, agentConfig, containerName);
  run(`docker compose -f "${composePath()}" -p ${containerName} down`, { env });
  console.log("Container stopped. (Volume preserved — use 'down -v' to remove)");
}

async function status(config, agentConfig, containerName) {
  const port = getPort(config);

  console.log(`\n=== Lab Environment Status: ${agentConfig.displayName || agentConfig.name} ===\n`);

  const stageDir = path.join(LAB_ROOT, ".lab-staging", agentConfig.name);
  if (fs.existsSync(stageDir)) {
    console.log(`  Staging dir: ${stageDir} (exists)`);
  } else {
    console.log(`  Staging dir: ${stageDir} (NOT FOUND — run --init)`);
  }

  try {
    const state = runCapture(`docker inspect -f "{{.State.Status}}" ${containerName}`);
    const health = runCapture(`docker inspect -f "{{.State.Health.Status}}" ${containerName}`);
    console.log(`  Container:   ${containerName} (${state}, health: ${health})`);
  } catch {
    console.log("  Container:   not running");
  }

  try {
    const resp = await fetch(`http://localhost:${port}/healthz`);
    console.log(`  HTTP /healthz: ${resp.status} ${resp.statusText}`);
  } catch {
    console.log("  HTTP /healthz: unreachable");
  }
}

// ── Main ──

const opts = parseArgs();
const config = loadConfig();
const agentConfig = loadAgentConfig(opts.agent);
const containerName = getContainerName(config, opts.agent);

switch (opts.command) {
  case "init": await init(config, agentConfig, containerName); break;
  case "refresh": await refresh(config, agentConfig, containerName); break;
  case "stop": stop(config, agentConfig, containerName); break;
  case "status": await status(config, agentConfig, containerName); break;
}
